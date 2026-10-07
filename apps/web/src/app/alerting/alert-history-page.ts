import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatChip, MatChipSet } from '@angular/material/chips';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { Subject, catchError, map, of, switchMap, tap } from 'rxjs';
import { NOW } from '../core/clock';
import { Telemetry } from '../fleet/fleet.model';
import { FleetStore } from '../fleet/fleet.store';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AlertHistoryApi } from './alert-history-api.service';
import {
  TurbineAlerts,
  fromUtcInput,
  groupAlertsByTurbine,
  last24Hours,
  rangeError,
  toUtcInput,
} from './alert-history';
import { describeRuleWithLevel } from './alert-config.model';
import { AlertingTabs } from './alerting-tabs';
import { describeTriggerWithLevel } from './alert-text';

/**
 * /alerting/history: the readings that triggered alert rules in a time range (GET /api/alerts),
 * default the last 24 hours. A Material table with expandable rows: one summary row per turbine
 * (latest alert, each distinct rule as a Material chip with its count) that
 * expands to its flagged readings, newest first, each with its rules as chips. 25 turbines per
 * page. The range is in UTC like every time in the app; changing it reloads.
 */
@Component({
  selector: 'app-alert-history-page',
  imports: [
    AlertingTabs,
    DatePipe,
    MatButton,
    MatChip,
    MatChipSet,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    RouterLink,
    TABLE_IMPORTS,
  ],
  templateUrl: './alert-history-page.html',
  // A column filling the shell's window-high page (route data `fillViewport`): heading, tabs and
  // range keep their height, the table frame takes what is left and scrolls its rows.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertHistoryPage {
  private readonly api = inject(AlertHistoryApi);
  private readonly fleet = inject(FleetStore);

  /** The range inputs (`datetime-local`, UTC). */
  protected readonly fromInput = signal('');
  protected readonly toInput = signal('');
  protected readonly error = computed(() =>
    rangeError(fromUtcInput(this.fromInput()), fromUtcInput(this.toInput())),
  );

  protected readonly readings = signal<Telemetry[]>([]);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly turbineCount = computed(
    () => new Set(this.readings().map((r) => r.turbineId)).size,
  );

  /** One summary row per turbine, 25 per page. */
  protected readonly turbines = computed(() =>
    groupAlertsByTurbine(this.readings(), (farmId) => this.farmName(farmId)),
  );
  protected readonly paging = paginate(this.turbines, 25);
  protected readonly columns = ['expand', 'turbine', 'farm', 'latest', 'rules'];
  protected readonly trackTurbine = (_: number, t: TurbineAlerts) => t.turbineId;
  /** The turbines whose rows are expanded (any number at once). */
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  protected readonly describe = describeTriggerWithLevel;
  protected readonly ruleChip = describeRuleWithLevel;

  /**
   * Range requests: `switchMap` keeps only the latest range's answer (like AlertRulesStore); a
   * failed load keeps the last results and shows the error with a retry.
   */
  private readonly requests = new Subject<{ from: string; to: string }>();

  constructor() {
    this.requests
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.failed.set(false);
        }),
        switchMap(({ from, to }) =>
          this.api.list(from, to).pipe(
            map((readings): Telemetry[] | null => readings),
            catchError(() => of(null)),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((readings) => {
        if (readings) {
          this.readings.set(readings);
          this.expanded.set(new Set());
          this.paging.reset();
        } else {
          this.failed.set(true);
        }
        this.loading.set(false);
      });

    const { from, to } = last24Hours(inject(NOW)());
    this.fromInput.set(toUtcInput(from));
    this.toInput.set(toUtcInput(to));
    this.load();
  }

  protected isExpanded(turbineId: string): boolean {
    return this.expanded().has(turbineId);
  }

  /** Opens or closes a turbine's detail row (the row or its expand button). */
  protected toggle(turbineId: string): void {
    this.expanded.update((open) => {
      const next = new Set(open);
      if (!next.delete(turbineId)) next.add(turbineId);
      return next;
    });
  }

  protected onFrom(event: Event): void {
    this.fromInput.set((event.target as HTMLInputElement).value);
    this.load();
  }

  protected onTo(event: Event): void {
    this.toInput.set((event.target as HTMLInputElement).value);
    this.load();
  }

  /** Loads the current range (an invalid range keeps the last results and shows why). */
  protected load(): void {
    if (this.error()) return;
    const from = new Date(fromUtcInput(this.fromInput())!).toISOString();
    const to = new Date(fromUtcInput(this.toInput())!).toISOString();
    this.requests.next({ from, to });
  }

  private readonly farmNames = computed(
    () => new Map(this.fleet.farms().map((farm) => [farm.id, farm.name])),
  );

  private farmName(farmId: string): string | null {
    return this.farmNames().get(farmId) ?? null;
  }
}
