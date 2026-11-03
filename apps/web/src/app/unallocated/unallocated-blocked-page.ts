import { Component, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { map } from 'rxjs';
import { AppTimePipe } from '../core/app-time.pipe';
import { TimeZoneSettings } from '../core/time-zone';
import { FarmPill } from '../ui/farm-pill';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { UnallocatedActions } from './unallocated-actions';
import { UnallocatedApi } from './unallocated-api.service';
import { UnallocatedTabs } from './unallocated-tabs';
import { UNALLOCATED_STATUS, UnallocatedStore } from './unallocated.store';
import { KIND_LABELS, UnallocatedKind, UnallocatedTurbine, farmName } from './unallocated.model';

/**
 * /unallocated/blocked (owner and up): the (turbine, reported farm) pairs whose readings
 * ingestion drops, with who blocked them and when. Unblock forgets the pair: its next reading
 * shows under Pending again. 25 per page.
 */
@Component({
  selector: 'app-unallocated-blocked-page',
  providers: [
    UnallocatedStore,
    { provide: UNALLOCATED_STATUS, useValue: 'blocked' },
    UnallocatedActions,
  ],
  imports: [AppTimePipe, FarmPill, MatButton, TABLE_IMPORTS, UnallocatedTabs],
  templateUrl: './unallocated-blocked-page.html',
})
export class UnallocatedBlockedPage {
  protected readonly store = inject(UnallocatedStore);
  protected readonly actions = inject(UnallocatedActions);
  private readonly api = inject(UnallocatedApi);

  protected readonly kindLabel = (kind: UnallocatedKind) => KIND_LABELS[kind];
  protected readonly tz = inject(TimeZoneSettings);
  protected readonly farmName = farmName;
  protected readonly paging = paginate(this.store.entries, 25);
  protected readonly columns = ['turbine', 'kind', 'reported', 'blockedAt', 'blockedBy', 'actions'];
  protected readonly trackById = (_: number, entry: UnallocatedTurbine) => entry.id;

  protected reload(): void {
    this.store.reload();
  }

  protected unblock(entry: UnallocatedTurbine): void {
    this.actions.run(entry, this.api.unblock(entry.id).pipe(map(() => ({ kind: 'unblocked' }))));
  }
}
