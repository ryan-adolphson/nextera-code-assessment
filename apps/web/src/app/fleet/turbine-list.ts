import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FleetStore, FleetTurbine } from './fleet.store';
import { STALENESS_LABELS, STALENESS_ORDER, Staleness } from './staleness';
import { StalenessBadge } from './staleness-badge';

export type TurbineSortKey = 'id' | 'farm' | 'status' | 'power' | 'wind' | 'gearbox' | 'time';
type SortValue = string | number | null;

/** The sortable columns, in table order; `value` is null for a turbine without readings. */
const COLUMNS: {
  key: TurbineSortKey;
  label: string;
  numeric: boolean;
  value: (t: FleetTurbine) => SortValue;
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
 * /turbines: every turbine of every farm with its status and latest reading, live. Sortable by
 * any column (default: turbine id), filterable by text (turbine id, farm id or name) and status.
 */
@Component({
  selector: 'app-turbine-list',
  imports: [DatePipe, DecimalPipe, RouterLink, StalenessBadge],
  templateUrl: './turbine-list.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurbineList {
  protected readonly store = inject(FleetStore);
  protected readonly columns = COLUMNS;
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

  protected readonly rows = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.status();
    const { key, dir } = this.sort();
    const value = COLUMNS.find((c) => c.key === key)!.value;
    return this.store
      .turbines()
      .filter(
        (t) =>
          (status === 'all' || t.staleness === status) &&
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
}

/** Ascending or descending; turbines without a value (no readings) always go last. */
function compare(a: SortValue, b: SortValue, dir: 'asc' | 'desc'): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const order = typeof a === 'number' ? a - (b as number) : a.localeCompare(b as string);
  return dir === 'asc' ? order : -order;
}
