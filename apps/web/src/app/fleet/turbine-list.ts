import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { AlertLevel, ALERT_RULE_LEVELS } from '../alerting/alert-config.model';
import { AlertLevelBadge } from '../alerting/alert-level-badge';
import { AlertRulesStore } from '../alerting/alert-rules.store';
import {
  LEVEL_SEVERITY,
  describeTriggerWithLevel,
  triggeredRules,
} from '../alerting/evaluate-alerts';
import { FleetStore, FleetTurbine } from './fleet.store';
import { STALENESS_LABELS, STALENESS_ORDER, Staleness } from './staleness';
import { StalenessBadge } from './staleness-badge';

export type TurbineSortKey =
  'id' | 'farm' | 'status' | 'commissioned' | 'alert' | 'power' | 'wind' | 'gearbox' | 'time';
type SortValue = string | number | null;

/**
 * The Alert cell of a turbine: the alert rules its LATEST reading (by measurement time) triggers,
 * also for stale turbines (the Status column shows staleness). `state`:
 * - `triggered`: `level` is the worst level (the visible pill); `details` lists every triggered
 *   rule with its level, worst first ("Error: Gearbox temperature 126.5 °C > 120"), for the
 *   pill's tooltip;
 * - `none`: no rule fires; `no-reading`: never reported;
 * - `loading` / `unavailable`: the rules are not loaded yet / could not be loaded.
 */
export interface AlertCell {
  state: 'triggered' | 'none' | 'no-reading' | 'loading' | 'unavailable';
  level: AlertLevel | null;
  details: string[];
}

export type AlertFilter = 'all' | 'none' | AlertLevel;

export type CommissionedFilter = 'all' | 'yes' | 'no';

/** The sortable columns, in table order; `value` is null for a turbine without a value. */
const COLUMNS: {
  key: TurbineSortKey;
  label: string;
  numeric: boolean;
  value: (t: FleetTurbine, alert: AlertCell) => SortValue;
}[] = [
  { key: 'id', label: 'Turbine', numeric: false, value: (t) => t.id },
  { key: 'farm', label: 'Farm', numeric: false, value: (t) => t.farmName },
  {
    key: 'status',
    label: 'Status',
    numeric: false,
    value: (t) => STALENESS_ORDER.indexOf(t.staleness),
  },
  {
    // Commissioned (check mark) first, like Status: in service first.
    key: 'commissioned',
    label: 'Commissioned',
    numeric: false,
    value: (t) => (t.commissioned ? 0 : 1),
  },
  {
    // None, then Info, Warning, Error (like Status: best first); no reading or no rules: last.
    key: 'alert',
    label: 'Alert',
    numeric: false,
    value: (_, a) =>
      a.state === 'none' ? 0 : a.state === 'triggered' ? LEVEL_SEVERITY[a.level!] : null,
  },
  {
    key: 'power',
    label: 'Power (kW)',
    numeric: true,
    value: (t) => t.latest?.powerOutputKw ?? null,
  },
  { key: 'wind', label: 'Wind (m/s)', numeric: true, value: (t) => t.latest?.windSpeedMs ?? null },
  {
    key: 'gearbox',
    label: 'Gearbox (°C)',
    numeric: true,
    value: (t) => t.latest?.gearboxTempC ?? null,
  },
  {
    key: 'time',
    label: 'Last reading (UTC)',
    numeric: false,
    value: (t) => t.latest?.timestamp ?? null,
  },
];

/**
 * /turbines: every turbine of every farm with its status, the alert rules its latest reading
 * triggers and the reading itself, live (readings from FleetStore, rules from AlertRulesStore).
 * Sortable by any column (default: turbine id), filterable by text (turbine id, farm id or name),
 * status, commissioning and alert.
 */
@Component({
  selector: 'app-turbine-list',
  imports: [
    AlertLevelBadge,
    DatePipe,
    DecimalPipe,
    MatIcon,
    MatTooltip,
    RouterLink,
    StalenessBadge,
  ],
  templateUrl: './turbine-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurbineList {
  protected readonly store = inject(FleetStore);
  protected readonly rulesStore = inject(AlertRulesStore);
  protected readonly columns = COLUMNS;
  protected readonly alertFilters: { value: AlertFilter; label: string }[] = [
    { value: 'all', label: 'Any' },
    ...[...ALERT_RULE_LEVELS].reverse(),
    { value: 'none', label: 'None' },
  ];
  protected readonly commissionedFilters: { value: CommissionedFilter; label: string }[] = [
    { value: 'all', label: 'Any' },
    { value: 'yes', label: 'Commissioned' },
    { value: 'no', label: 'Not commissioned' },
  ];
  protected readonly statuses = STALENESS_ORDER.map((s) => ({
    value: s,
    label: STALENESS_LABELS[s],
  }));

  protected readonly sort = signal<{ key: TurbineSortKey; dir: 'asc' | 'desc' }>({
    key: 'id',
    dir: 'asc',
  });
  protected readonly query = signal('');
  protected readonly status = signal<Staleness | 'all'>('all');
  protected readonly alertFilter = signal<AlertFilter>('all');
  protected readonly commissionedFilter = signal<CommissionedFilter>('all');

  /** Each turbine's Alert cell, by turbine id; follows live readings and rule changes. */
  protected readonly alerts = computed(() => {
    const rules = this.rulesStore.rules();
    const unavailable = this.rulesStore.failed()
      ? 'unavailable'
      : this.rulesStore.loading()
        ? 'loading'
        : null;
    return new Map(
      this.store.turbines().map((t): [string, AlertCell] => {
        const r = t.latest;
        if (!r) return [t.id, { state: 'no-reading', level: null, details: [] }];
        if (unavailable) return [t.id, { state: unavailable, level: null, details: [] }];
        const triggered = triggeredRules(r, rules);
        return [
          t.id,
          triggered.length
            ? {
                state: 'triggered',
                level: triggered[0].alertLevel,
                details: triggered.map((rule) => describeTriggerWithLevel(r, rule)),
              }
            : { state: 'none', level: null, details: [] },
        ];
      }),
    );
  });

  protected readonly rows = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.status();
    const alertFilter = this.alertFilter();
    const commissioned = this.commissionedFilter();
    const alerts = this.alerts();
    const { key, dir } = this.sort();
    const column = COLUMNS.find((c) => c.key === key)!;
    const value = (t: FleetTurbine) => column.value(t, alerts.get(t.id)!);
    return this.store
      .turbines()
      .filter(
        (t) =>
          (status === 'all' || t.staleness === status) &&
          (commissioned === 'all' || t.commissioned === (commissioned === 'yes')) &&
          matchesAlert(alerts.get(t.id)!, alertFilter) &&
          (!query || [t.id, t.farmId, t.farmName].some((s) => s.toLowerCase().includes(query))),
      )
      .sort((a, b) => compare(value(a), value(b), dir) || a.id.localeCompare(b.id));
  });

  /** Same column: reverse the order; another column: sort by it, ascending. */
  protected sortBy(key: TurbineSortKey): void {
    this.sort.update((s) =>
      s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }

  protected ariaSort(key: TurbineSortKey): 'ascending' | 'descending' | null {
    const s = this.sort();
    if (s.key !== key) return null;
    return s.dir === 'asc' ? 'ascending' : 'descending';
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected onStatus(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value as Staleness | 'all');
  }

  protected onCommissionedFilter(event: Event): void {
    this.commissionedFilter.set((event.target as HTMLSelectElement).value as CommissionedFilter);
  }

  protected onAlertFilter(event: Event): void {
    this.alertFilter.set((event.target as HTMLSelectElement).value as AlertFilter);
  }
}

/** "Any" keeps every turbine; the others need an evaluated reading with that outcome. */
function matchesAlert(alert: AlertCell, filter: AlertFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'none') return alert.state === 'none';
  return alert.state === 'triggered' && alert.level === filter;
}

/** Ascending or descending; turbines without a value (no readings) always go last. */
function compare(a: SortValue, b: SortValue, dir: 'asc' | 'desc'): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const order = typeof a === 'number' ? a - (b as number) : a.localeCompare(b as string);
  return dir === 'asc' ? order : -order;
}
