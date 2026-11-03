import { DecimalPipe } from '@angular/common';
import { Component, ViewContainerRef, computed, inject, signal } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuContent, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { map } from 'rxjs';
import { FleetStore } from '../fleet/fleet.store';
import { StalenessBadge } from '../fleet/staleness-badge';
import { stalenessOf } from '../fleet/staleness';
import { AppTimePipe } from '../core/app-time.pipe';
import { TimeZoneSettings } from '../core/time-zone';
import { FarmPill } from '../ui/farm-pill';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AssignDialog } from './assign-dialog';
import { HeldReadings } from './held-readings';
import { ConfirmData, UnallocatedConfirmDialog } from './unallocated-confirm-dialog';
import { UnallocatedActions } from './unallocated-actions';
import { UnallocatedApi } from './unallocated-api.service';
import { UnallocatedTabs } from './unallocated-tabs';
import { UNALLOCATED_STATUS, UnallocatedStore } from './unallocated.store';
import { KIND_LABELS, UnallocatedKind, UnallocatedTurbine, farmName } from './unallocated.model';

/** A table row: the entry and what the cells show. */
interface PendingRow {
  entry: UnallocatedTurbine;
  staleness: ReturnType<typeof stalenessOf>;
}

/**
 * /unallocated/pending (owner and up): turbines whose readings ingestion holds because the id is
 * not in the fleet or the reading names another farm. One row per (turbine, reported farm), most
 * recently seen first, 25 per page; a row expands to its newest held readings. Each row has one
 * primary action by kind: an unknown turbine is assigned to a farm (dialog), a farm mismatch is kept
 * in its farm (direct). Its "More actions" menu moves a mismatch to the reported farm (confirmed;
 * disabled, with the reason, when that farm doesn't exist) and blocks either kind (confirmed). Reloads on
 * `unallocated-turbine.changed` (any browser, or ingestion holding a new turbine).
 */
@Component({
  selector: 'app-unallocated-pending-page',
  providers: [
    UnallocatedStore,
    { provide: UNALLOCATED_STATUS, useValue: 'pending' },
    UnallocatedActions,
  ],
  imports: [
    AppTimePipe,
    DecimalPipe,
    FarmPill,
    HeldReadings,
    MatButton,
    MatIcon,
    MatIconButton,
    MatMenu,
    MatMenuContent,
    MatMenuItem,
    MatMenuTrigger,
    StalenessBadge,
    TABLE_IMPORTS,
    UnallocatedTabs,
  ],
  templateUrl: './unallocated-pending-page.html',
})
export class UnallocatedPendingPage {
  protected readonly store = inject(UnallocatedStore);
  protected readonly actions = inject(UnallocatedActions);
  private readonly api = inject(UnallocatedApi);
  private readonly fleet = inject(FleetStore);
  /** Opening dialogs here puts them in this page's injector (they reach its UnallocatedStore). */
  private readonly viewContainerRef = inject(ViewContainerRef);

  protected readonly kindLabel = (kind: UnallocatedKind) => KIND_LABELS[kind];
  protected readonly tz = inject(TimeZoneSettings);
  protected readonly farmName = farmName;

  protected readonly rows = computed<PendingRow[]>(() =>
    this.store.entries().map((entry) => ({
      entry,
      // How long since its newest held reading was measured (on the shell's minute clock).
      staleness: stalenessOf(entry.latest, this.fleet.now()),
    })),
  );
  protected readonly paging = paginate(this.rows, 25);
  protected readonly columns = ['expand', 'turbine', 'farms', 'seen', 'held', 'actions'];
  protected readonly trackById = (_: number, row: PendingRow) => row.entry.id;
  /** The entries whose rows are expanded (any number at once). */
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  /** Opens or closes an entry's readings (the row or its expand button). */
  protected toggle(id: string): void {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected reload(): void {
    this.store.reload();
  }

  protected assign(entry: UnallocatedTurbine): void {
    this.actions.open(AssignDialog, entry, entry, this.viewContainerRef);
  }

  protected keep(entry: UnallocatedTurbine): void {
    this.actions.run(
      entry,
      this.api.keep(entry.id).pipe(map((resolution) => ({ kind: 'resolved', resolution }))),
    );
  }

  protected move(entry: UnallocatedTurbine): void {
    // No farm to move to: the menu item stays focusable (disabledInteractive) but does nothing.
    if (entry.reportedFarm === null) return;
    this.confirm(entry, 'move');
  }

  protected block(entry: UnallocatedTurbine): void {
    this.confirm(entry, 'block');
  }

  private confirm(entry: UnallocatedTurbine, action: ConfirmData['action']): void {
    this.actions.open<UnallocatedConfirmDialog, ConfirmData>(
      UnallocatedConfirmDialog,
      { entry, action },
      entry,
      this.viewContainerRef,
    );
  }
}
