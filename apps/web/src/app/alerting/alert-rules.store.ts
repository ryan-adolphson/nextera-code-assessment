import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { FleetStore } from '../fleet/fleet.store';
import { latestLoad } from '../ui/latest-load';
import { AlertConfigApi } from './alert-config-api.service';
import { AlertConfig } from './alert-config.model';

/**
 * The alert rules (GET /api/alert-configs), provided by the Rules page (its only user; alerts are
 * evaluated by ingestion, not in the browser). Needs the shell's FleetStore. Loaded when first
 * used, and reloaded on every `alert-config.changed` (FleetStore's `alertConfigVersion`, from the
 * shell's one SSE connection) and after local writes (`reload()`). Built on `latestLoad` (an
 * `rxResource`), so a stale response never wins when reloads overlap. A failed load keeps the
 * last rules.
 */
@Injectable()
export class AlertRulesStore {
  private readonly api = inject(AlertConfigApi);
  private readonly fleet = inject(FleetStore);
  private readonly load = latestLoad<void, AlertConfig[]>(() => this.api.list());

  readonly rules = computed(() => this.load.value() ?? []);
  /** True when the latest load failed (the rules may be missing or out of date). */
  readonly failed = this.load.failed;
  /** True until the first response (success or failure). */
  readonly loading = computed(() => this.load.value() === null && !this.failed());

  constructor() {
    effect(() => {
      this.fleet.alertConfigVersion();
      untracked(() => this.reload());
    });
  }

  reload(): void {
    this.load.run();
  }
}
