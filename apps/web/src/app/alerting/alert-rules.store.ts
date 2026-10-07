import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, map, of, switchMap } from 'rxjs';
import { FleetStore } from '../fleet/fleet.store';
import { AlertConfigApi } from './alert-config-api.service';
import { AlertConfig } from './alert-config.model';

/**
 * The alert rules (GET /api/alert-configs), provided by FleetShell next to FleetStore and used by
 * the Rules page (alerts are evaluated by ingestion, not in the browser). Loaded when first used, and reloaded on every `alert-config.changed` (FleetStore's
 * `alertConfigVersion`, from the shell's one SSE connection) and after local writes (`reload()`).
 * `switchMap` drops a stale response when reloads overlap. A failed load keeps the last rules.
 */
@Injectable()
export class AlertRulesStore {
  private readonly api = inject(AlertConfigApi);
  private readonly fleet = inject(FleetStore);
  private readonly reloads = new Subject<void>();

  readonly rules = signal<AlertConfig[]>([]);
  /** True until the first response (success or failure). */
  readonly loading = signal(true);
  /** True when the latest load failed (the rules may be missing or out of date). */
  readonly failed = signal(false);

  constructor() {
    this.reloads
      .pipe(
        switchMap(() =>
          this.api.list().pipe(
            map((rules): AlertConfig[] | null => rules),
            catchError(() => of(null)),
          ),
        ),
        takeUntilDestroyed(inject(DestroyRef)),
      )
      .subscribe((rules) => {
        if (rules) this.rules.set(rules);
        this.failed.set(!rules);
        this.loading.set(false);
      });
    effect(() => {
      this.fleet.alertConfigVersion();
      untracked(() => this.reload());
    });
  }

  reload(): void {
    this.reloads.next();
  }
}
