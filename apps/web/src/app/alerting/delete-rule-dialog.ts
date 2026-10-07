import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
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
import { errorMessage, statusOf } from './rule-errors';

/**
 * Confirms and deletes an alert rule (opened by the Rules page with MatDialog). Closes with `true`
 * once the rule is gone, also when it was already deleted elsewhere (404); any other failure (e.g.
 * 409: readings triggered it, disable it instead) is shown here and the dialog stays open. Cancel
 * gets the initial focus.
 */
@Component({
  selector: 'app-delete-rule-dialog',
  imports: [MatButton, MatDialogActions, MatDialogClose, MatDialogContent, MatDialogTitle],
  template: `
    <h2 mat-dialog-title>Delete alert rule?</h2>
    <mat-dialog-content>
      <p class="m-0">
        <strong>{{ describe }}</strong> ({{ level }}) will be removed. This can’t be undone.
      </p>
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
    </mat-dialog-actions>
  `,
  host: { 'data-testid': 'delete-dialog' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeleteRuleDialog {
  private readonly api = inject(AlertConfigApi);
  private readonly dialog = inject<MatDialogRef<DeleteRuleDialog, boolean>>(MatDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly rule = inject<AlertConfig>(MAT_DIALOG_DATA);
  protected readonly describe = describeRule(this.rule);
  protected readonly level = levelLabel(this.rule.alertLevel);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected delete(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    this.api
      .remove(this.rule.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => this.dialog.close(true),
        error: (e: unknown) => {
          this.busy.set(false);
          if (statusOf(e) === 404)
            this.dialog.close(true); // already gone: the reload shows it
          else this.error.set(errorMessage(e));
        },
      });
  }
}
