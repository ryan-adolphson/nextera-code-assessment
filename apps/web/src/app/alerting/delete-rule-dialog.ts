import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { AlertConfigApi } from './alert-config-api.service';
import { AlertConfig, describeRule, levelLabel } from './alert-config.model';
import { errorMessage, statusOf } from '../core/http-errors';
import { triggeredMessage } from './rule-errors';

/** How the delete dialog ended (undefined: cancelled or closed without a change). */
export type DeleteRuleResult = 'deleted' | 'disabled';

/**
 * Confirms and deletes an alert rule (opened by the Rules page with MatDialog). Closes with
 * `'deleted'` once the rule is gone, also when it was already deleted elsewhere (404). A 409 from
 * this DELETE means readings triggered the rule (their history keeps it): the dialog says so in
 * words (never the API's text, which names the internal id) and offers "Disable rule" (PATCH
 * `enabled: false`, closes with `'disabled'`), or only Close when the rule is already disabled.
 * Other failures are shown here and the dialog stays open. Cancel gets the initial focus.
 */
@Component({
  selector: 'app-delete-rule-dialog',
  imports: [MatButton, MatDialogActions, MatDialogClose, MatDialogContent, MatDialogTitle],
  template: `
    <h2 mat-dialog-title>
      {{ triggered() ? 'This rule can’t be deleted' : 'Delete alert rule?' }}
    </h2>
    <mat-dialog-content>
      <p class="m-0">
        <strong>{{ describe }}</strong> ({{ level }})
        @if (!triggered()) {
          will be removed. This can’t be undone.
        }
      </p>
      @if (triggered()) {
        <p
          class="mt-3 mb-0 rounded-md border border-line bg-surface px-3 py-2 text-sm"
          role="alert"
          data-testid="delete-triggered"
        >
          {{ triggeredText }}
        </p>
      }
      @if (error(); as error) {
        <p
          class="mt-3 mb-0 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger"
          role="alert"
          data-testid="delete-error"
        >
          {{ error }}
        </p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (!triggered()) {
        <button matButton="outlined" type="button" mat-dialog-close cdkFocusInitial>Cancel</button>
        <button
          matButton="filled"
          type="button"
          class="danger-button"
          data-testid="confirm-delete"
          [disabled]="busy()"
          (click)="delete()"
        >
          {{ busy() ? 'Deleting…' : 'Delete rule' }}
        </button>
      } @else if (rule.enabled) {
        <button matButton="outlined" type="button" mat-dialog-close>Cancel</button>
        <button
          #next
          matButton="filled"
          type="button"
          data-testid="disable-rule"
          [disabled]="busy()"
          (click)="disable()"
        >
          {{ busy() ? 'Disabling…' : 'Disable rule' }}
        </button>
      } @else {
        <button #next matButton="filled" type="button" data-testid="close-delete" mat-dialog-close>
          Close
        </button>
      }
    </mat-dialog-actions>
  `,
  host: { 'data-testid': 'delete-dialog' },
})
export class DeleteRuleDialog {
  private readonly api = inject(AlertConfigApi);
  private readonly dialog = inject<MatDialogRef<DeleteRuleDialog, DeleteRuleResult>>(MatDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  protected readonly rule = inject<AlertConfig>(MAT_DIALOG_DATA);
  protected readonly describe = describeRule(this.rule);
  protected readonly level = levelLabel(this.rule.alertLevel);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  /** The DELETE answered 409: readings triggered the rule. */
  protected readonly triggered = signal(false);
  protected readonly triggeredText = triggeredMessage(this.rule.enabled);
  /** The button that replaces "Delete rule" after a 409 (Disable rule, or Close). */
  private readonly next = viewChild('next', { read: ElementRef });

  protected delete(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    this.api
      .remove(this.rule.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => this.dialog.close('deleted'),
        error: (e: unknown) => {
          this.busy.set(false);
          const status = statusOf(e);
          if (status === 404) {
            this.dialog.close('deleted'); // already gone: the reload shows it
          } else if (status === 409) {
            this.triggered.set(true);
            // The focused "Delete rule" button is gone: focus what replaced it.
            afterNextRender(() => this.next()?.nativeElement.focus(), { injector: this.injector });
          } else {
            this.error.set(errorMessage(e));
          }
        },
      });
  }

  /** Disables the rule instead (it stays on the readings it flagged, but is no longer evaluated). */
  protected disable(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    this.api
      .setEnabled(this.rule.id, false)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.dialog.close('disabled'),
        error: (e: unknown) => {
          this.busy.set(false);
          if (statusOf(e) === 404) this.dialog.close('deleted');
          else this.error.set(`Could not disable the rule. ${errorMessage(e)}`);
        },
      });
  }
}
