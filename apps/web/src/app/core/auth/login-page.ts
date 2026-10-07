import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, FormRoot, email, form, required } from '@angular/forms/signals';
import { MatButton } from '@angular/material/button';
import { MatError, MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { Router } from '@angular/router';
import { safeReturnUrl } from './auth.guards';
import { AuthStore } from './auth.store';

/** The API's one message for every failed sign-in (it never says which part was wrong). */
export const INVALID_CREDENTIALS = 'Invalid email or password.';

interface LoginModel {
  email: string;
  password: string;
}

/**
 * /login (outside the FleetShell): email + password → POST /api/auth/login, then back to
 * `returnUrl` (set by the auth guard) or /farms. A Signal Form on Material outline fields:
 * `[formRoot]` marks every field touched on submit and runs the sign-in only when valid; `submitting()`
 * is the busy state, so a second submit is ignored.
 */
@Component({
  selector: 'app-login-page',
  imports: [FormField, FormRoot, MatButton, MatError, MatFormField, MatInput, MatLabel],
  templateUrl: './login-page.html',
})
export class LoginPage {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  /** Query parameter (withComponentInputBinding). */
  readonly returnUrl = input<string>();

  private readonly model = signal<LoginModel>({ email: '', password: '' });
  protected readonly loginForm = form(
    this.model,
    (login) => {
      required(login.email, { message: 'Enter your email address.' });
      email(login.email, { message: 'Enter a valid email address.' });
      required(login.password, { message: 'Enter your password.' });
    },
    {
      submission: {
        action: () => this.signIn(),
        onInvalid: () => this.error.set(null),
      },
    },
  );

  protected readonly busy = computed(() => this.loginForm().submitting());
  protected readonly error = signal<string | null>(null);

  /** The first error message of a field (shown by `<mat-error>` once it's touched). */
  protected messageOf(field: 'email' | 'password'): string {
    return this.loginForm[field]().errors()[0]?.message ?? '';
  }

  private signIn(): Promise<undefined> {
    this.error.set(null);
    const { email, password } = this.model();
    return new Promise((resolve) =>
      this.auth
        .login(email, password)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          next: () => {
            void this.router.navigateByUrl(safeReturnUrl(this.returnUrl()));
            resolve(undefined);
          },
          error: (e: unknown) => {
            this.error.set(loginErrorMessage(e));
            // Keep the email, clear the password for the next attempt.
            this.model.update((m) => ({ ...m, password: '' }));
            resolve(undefined);
          },
        }),
    );
  }
}

export function loginErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 401 || error.status === 400) return INVALID_CREDENTIALS;
    if (error.status === 0) return 'Could not reach the API. Check your connection and try again.';
    if (error.status === 429) return 'Too many attempts. Wait a minute and try again.';
  }
  return 'Could not sign in. Try again.';
}
