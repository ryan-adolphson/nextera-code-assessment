import { DestroyRef, Injectable, ViewContainerRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatDialog, MatDialogConfig } from '@angular/material/dialog';
import { ComponentType } from '@angular/cdk/portal';
import { Observable } from 'rxjs';
import { errorMessage, statusOf } from '../core/http-errors';
import { FleetStore } from '../fleet/fleet.store';
import { UnallocatedStore } from './unallocated.store';
import {
  UnallocatedOutcome,
  UnallocatedTurbine,
  isEntryGone,
  outcomeNotice,
} from './unallocated.model';

/** Every dialog: up to 32rem (never wider than the screen less a margin), modal. */
const DIALOG_CONFIG: MatDialogConfig = {
  width: '32rem',
  maxWidth: 'calc(100vw - 2rem)',
  autoFocus: 'first-tabbable',
  ariaModal: true,
};

/**
 * What the Unallocated pages do after an action, in one place (provided by each page, next to its
 * UnallocatedStore): announce the outcome (`notice`), reload the list, and reload the fleet after
 * an assign, keep or move (the shell's `fleet.changed` does too; this covers a moment without a
 * live connection). Direct actions (Keep, Unblock) run here: `busyId` while in flight, failures in
 * `error` (a 409 also reloads the list; a 404 means it was resolved elsewhere). Dialogs (Assign,
 * Move, Block) run their request themselves and close with the outcome.
 */
@Injectable()
export class UnallocatedActions {
  private readonly store = inject(UnallocatedStore);
  private readonly fleet = inject(FleetStore);
  private readonly dialog = inject(MatDialog);
  private readonly destroyRef = inject(DestroyRef);

  /** The last outcome, announced politely. */
  readonly notice = signal('');
  /** The last direct action's failure (shown as an alert on the page). */
  readonly error = signal<string | null>(null);
  /** The entry whose direct action is in flight. */
  readonly busyId = signal<string | null>(null);

  /** Opens a dialog in the page's injector (it reaches the page's store) and applies its outcome. */
  open<C, D>(
    component: ComponentType<C>,
    data: D,
    entry: UnallocatedTurbine,
    viewContainerRef: ViewContainerRef,
  ): void {
    this.error.set(null);
    this.dialog
      .open<C, D, UnallocatedOutcome>(component, { ...DIALOG_CONFIG, viewContainerRef, data })
      .afterClosed()
      .subscribe((outcome) => {
        if (outcome) this.done(entry, outcome); // undefined: cancelled (Esc, Cancel)
      });
  }

  /** Runs a direct action (one at a time) and applies its outcome. */
  run(entry: UnallocatedTurbine, request: Observable<UnallocatedOutcome>): void {
    if (this.busyId()) return;
    this.error.set(null);
    this.busyId.set(entry.id);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (outcome) => {
        this.busyId.set(null);
        this.done(entry, outcome);
      },
      error: (e: unknown) => {
        this.busyId.set(null);
        if (isEntryGone(e)) {
          this.done(entry, { kind: 'gone' });
          return;
        }
        this.error.set(errorMessage(e));
        if (statusOf(e) === 409) this.store.reload(); // e.g. blocked meanwhile: show the list as is
      },
    });
  }

  private done(entry: UnallocatedTurbine, outcome: UnallocatedOutcome): void {
    const farmNames = new Map(this.fleet.farms().map((f) => [f.id, f.name]));
    if (outcome.kind === 'resolved') {
      // The new turbine's own farm name may not be loaded yet: the entry knows the reported one.
      if (entry.reportedFarm) farmNames.set(entry.reportedFarm.id, entry.reportedFarm.name);
      if (entry.currentFarm) farmNames.set(entry.currentFarm.id, entry.currentFarm.name);
      this.fleet.reloadFleet(entry.turbineId);
    }
    this.notice.set(outcomeNotice(entry, outcome, (id) => farmNames.get(id) ?? null));
    this.store.reload();
  }
}
