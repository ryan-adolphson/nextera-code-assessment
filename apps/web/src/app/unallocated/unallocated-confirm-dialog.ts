import { Component, DestroyRef, inject, signal } from '@angular/core';
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
import { Observable, map } from 'rxjs';
import { errorMessage, statusOf } from '../core/http-errors';
import { UnallocatedApi } from './unallocated-api.service';
import { UnallocatedStore } from './unallocated.store';
import {
  UnallocatedOutcome,
  UnallocatedTurbine,
  farmLabel,
  isEntryGone,
} from './unallocated.model';

/** What the Pending page passes in: the entry, and whether to move or block it. */
export interface ConfirmData {
  entry: UnallocatedTurbine;
  action: 'move' | 'block';
}

/**
 * Confirms and runs Move (a farm mismatch: the turbine and its history go to the reported farm) or
 * Block (drop this turbine id's readings from this farm until unblocked), opened by the Pending
 * page with MatDialog. Closes with the outcome on success, or `gone` when the entry was resolved
 * elsewhere (404). A conflict (409, e.g. blocked meanwhile) is shown here and reloads the list
 * behind the dialog; other failures are shown and the dialog stays open. Cancel gets the initial
 * focus.
 */
@Component({
  selector: 'app-unallocated-confirm-dialog',
  imports: [MatButton, MatDialogActions, MatDialogClose, MatDialogContent, MatDialogTitle],
  template: `
    <h2 mat-dialog-title>{{ title }}</h2>
    <mat-dialog-content>
      @if (data.action === 'move') {
        <p class="m-0" data-testid="confirm-text">
          <strong>{{ entry.turbineId }}</strong> and all its readings will move to {{ reported }};
          {{ current }} reports will no longer include them. Its {{ entry.heldCount }} held
          {{ entry.heldCount === 1 ? 'reading is' : 'readings are' }} imported under
          {{ entry.reportedFarmId }}.
        </p>
      } @else {
        <p class="m-0" data-testid="confirm-text">
          Readings for <strong>{{ entry.turbineId }}</strong> that report
          {{ entry.reportedFarmId }} will be dropped until you unblock it, and its
          {{ entry.heldCount }} held {{ entry.heldCount === 1 ? 'reading is' : 'readings are' }}
          deleted. Readings dropped while it is blocked can’t be recovered.
        </p>
      }
      @if (error(); as error) {
        <p
          class="mt-3 mb-0 rounded-md bg-danger-bg px-3 py-2 text-sm text-danger"
          role="alert"
          data-testid="confirm-error"
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
        data-testid="confirm-action"
        [class.danger-button]="data.action === 'block'"
        [disabled]="busy()"
        (click)="confirm()"
      >
        {{ busy() ? busyLabel : confirmLabel }}
      </button>
    </mat-dialog-actions>
  `,
  host: { 'data-testid': 'confirm-dialog', '[attr.data-action]': 'data.action' },
})
export class UnallocatedConfirmDialog {
  private readonly api = inject(UnallocatedApi);
  private readonly dialog =
    inject<MatDialogRef<UnallocatedConfirmDialog, UnallocatedOutcome>>(MatDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  /** The page's list (the page opens this dialog in its own injector). */
  private readonly store = inject(UnallocatedStore, { optional: true });
  protected readonly data = inject<ConfirmData>(MAT_DIALOG_DATA);
  protected readonly entry = this.data.entry;
  protected readonly reported = farmLabel(this.entry.reportedFarm, this.entry.reportedFarmId);
  protected readonly current = this.entry.currentFarm
    ? farmLabel(this.entry.currentFarm, this.entry.currentFarm.id)
    : 'its current farm’s';
  protected readonly title =
    this.data.action === 'move'
      ? `Move ${this.entry.turbineId} to ${this.entry.reportedFarmId}?`
      : `Block ${this.entry.turbineId} from ${this.entry.reportedFarmId}?`;
  protected readonly confirmLabel = this.data.action === 'move' ? 'Move turbine' : 'Block';
  protected readonly busyLabel = this.data.action === 'move' ? 'Moving…' : 'Blocking…';
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected confirm(): void {
    if (this.busy()) return;
    this.error.set(null);
    this.busy.set(true);
    const request: Observable<UnallocatedOutcome> =
      this.data.action === 'move'
        ? this.api.move(this.entry.id).pipe(map((resolution) => ({ kind: 'resolved', resolution })))
        : this.api.block(this.entry.id).pipe(map(() => ({ kind: 'blocked' })));
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (outcome) => this.dialog.close(outcome),
      error: (e: unknown) => {
        this.busy.set(false);
        if (isEntryGone(e)) {
          this.dialog.close({ kind: 'gone' });
          return;
        }
        this.error.set(errorMessage(e));
        // The list may be stale (e.g. blocked in another browser): reload it behind the dialog.
        if (statusOf(e) === 409) this.store?.reload();
      },
    });
  }
}
