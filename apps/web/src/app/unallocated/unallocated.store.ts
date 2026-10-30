import { Injectable, InjectionToken, computed, effect, inject, untracked } from '@angular/core';
import { FleetStore } from '../fleet/fleet.store';
import { latestLoad } from '../ui/latest-load';
import { UnallocatedApi } from './unallocated-api.service';
import { UnallocatedStatus, UnallocatedTurbine } from './unallocated.model';

/** Which list an `UnallocatedStore` loads (provided next to it by each tab's page). */
export const UNALLOCATED_STATUS = new InjectionToken<UnallocatedStatus>('UNALLOCATED_STATUS');

/**
 * The pending or blocked unallocated turbines (GET /api/unallocated-turbines?status=), provided by
 * the tab's page together with `UNALLOCATED_STATUS`. Needs the shell's FleetStore: reloads on
 * every `unallocated-turbine.changed` (its `unallocatedVersion`, also bumped by a resync after a
 * reconnect) and after local actions (`reload()`). Built on `latestLoad`, so a stale response
 * never wins; a failed load keeps the last list.
 */
@Injectable()
export class UnallocatedStore {
  private readonly api = inject(UnallocatedApi);
  private readonly fleet = inject(FleetStore);
  readonly status = inject(UNALLOCATED_STATUS);
  private readonly load = latestLoad<UnallocatedStatus, UnallocatedTurbine[]>((status) =>
    this.api.list(status),
  );

  readonly entries = computed(() => this.load.value() ?? []);
  /** True when the latest load failed (the list may be missing or out of date). */
  readonly failed = this.load.failed;
  /** True until the first response (success or failure). */
  readonly loading = computed(() => this.load.value() === null && !this.failed());

  constructor() {
    effect(() => {
      this.fleet.unallocatedVersion();
      untracked(() => this.reload());
    });
  }

  reload(): void {
    this.load.run(this.status);
  }
}
