import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatSort, MatSortHeader, Sort } from '@angular/material/sort';
import { RouterLink } from '@angular/router';
import { FleetStore, FleetTurbine } from './fleet.store';
import { STALENESS_LABELS, STALENESS_ORDER, Staleness } from './staleness';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { StalenessBadge } from './staleness-badge';

export type TurbineSortKey =
  'id' | 'farm' | 'status' | 'commissioned' | 'power' | 'wind' | 'gearbox' | 'time';
type SortValue = string | number | null;

export type CommissionedFilter = 'all' | 'yes' | 'no';

interface Column {
  key: TurbineSortKey;
  label: string;
  value: (t: FleetTurbine) => SortValue;
  /** Numeric columns: the latest reading's field and its number format. */
  reading?: { field: 'powerOutputKw' | 'windSpeedMs' | 'gearboxTempC'; format: string };
}
type NumericColumn = Column & { reading: NonNullable<Column['reading']> };

/** The sortable columns, in table order; `value` is null for a turbine without a value. */
const COLUMNS: Column[] = [
  { key: 'id', label: 'Turbine', value: (t) => t.id },
  { key: 'farm', label: 'Farm', value: (t) => t.farmName },
  {
    key: 'status',
    label: 'Status',
    value: (t) => STALENESS_ORDER.indexOf(t.staleness),
  },
  {
    // Commissioned (check mark) first, like Status: in service first.
    key: 'commissioned',
    label: 'Commissioned',
    value: (t) => (t.commissioned ? 0 : 1),
  },
  {
    key: 'power',
    label: 'Power (kW)',
    value: (t) => t.latest?.powerOutputKw ?? null,
    reading: { field: 'powerOutputKw', format: '1.0-0' },
  },
  {
    key: 'wind',
    label: 'Wind (m/s)',
    value: (t) => t.latest?.windSpeedMs ?? null,
    reading: { field: 'windSpeedMs', format: '1.1-1' },
  },
  {
    key: 'gearbox',
    label: 'Gearbox (°C)',
    value: (t) => t.latest?.gearboxTempC ?? null,
    reading: { field: 'gearboxTempC', format: '1.1-1' },
  },
  {
    key: 'time',
    label: 'Last reading (UTC)',
    value: (t) => t.latest?.timestamp ?? null,
  },
];

/**
 * The turbines table shared by /turbines (every turbine) and the farm page (one farm's turbines,
 * without the Farm column): filters (text, status, commissioning) with the match count, then a
 * Material table in a `TableFrame` with the status pill, Commissioned check mark or X, the latest
 * values and the last reading time; sortable by any column (default: turbine id; turbines without
 * readings last; ties by id), 25 rows per page, live (`data-updated` flash on the updated row).
 * Each turbine id links to its turbine page.
 */
@Component({
  selector: 'app-turbine-table',
  // Passes the window-high flex column through (route data `fillViewport` on /turbines): the
  // filters keep their height, the table frame takes what is left and scrolls its rows.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  imports: [
    DatePipe,
    DecimalPipe,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatSort,
    MatSortHeader,
    MatSuffix,
    RouterLink,
    StalenessBadge,
    TABLE_IMPORTS,
  ],
  templateUrl: './turbine-table.html',
})
export class TurbineTable {
  /** The turbines to list (already scoped: the whole fleet, or one farm), live from FleetStore. */
  readonly turbines = input.required<FleetTurbine[]>();
  /**
   * Columns to leave out, e.g. `['farm']` on a farm page. Without the farm column, the text filter
   * searches turbine ids only (a farm's id or name would match every row).
   */
  readonly hiddenColumns = input<readonly TurbineSortKey[]>([]);

  protected readonly store = inject(FleetStore);
  protected readonly columnKeys = computed(() =>
    COLUMNS.map((c) => c.key).filter((key) => !this.hiddenColumns().includes(key)),
  );
  protected readonly numericColumns = COLUMNS.filter((c): c is NumericColumn => !!c.reading);
  protected readonly searchesFarms = computed(() => !this.hiddenColumns().includes('farm'));
  protected readonly trackById = (_: number, t: FleetTurbine) => t.id;
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
  protected readonly commissionedFilter = signal<CommissionedFilter>('all');

  protected readonly rows = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.status();
    const commissioned = this.commissionedFilter();
    const { key, dir } = this.sort();
    const column = COLUMNS.find((c) => c.key === key)!;
    const value = (t: FleetTurbine) => column.value(t);
    const searched = (t: FleetTurbine) =>
      this.searchesFarms() ? [t.id, t.farmId, t.farmName] : [t.id];
    return this.turbines()
      .filter(
        (t) =>
          (status === 'all' || t.staleness === status) &&
          (commissioned === 'all' || t.commissioned === (commissioned === 'yes')) &&
          (!query || searched(t).some((s) => s.toLowerCase().includes(query))),
      )
      .sort((a, b) => compare(value(a), value(b), dir) || a.id.localeCompare(b.id));
  });

  /** Rows on the current page (Material paginator; 25 per page by default). */
  protected readonly paging = paginate(this.rows, 25);

  /**
   * MatSort with `matSortDisableClear`: the same column reverses the order, another column sorts
   * by it ascending. Back to the first page.
   */
  protected onSort(sort: Sort): void {
    this.sort.set({ key: sort.active as TurbineSortKey, dir: sort.direction || 'asc' });
    this.paging.reset();
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.paging.reset();
  }

  /** The search field's clear button: empty the text filter and keep typing where it was. */
  protected clearQuery(input: HTMLInputElement): void {
    this.query.set('');
    this.paging.reset();
    input.focus();
  }

  protected onStatus(event: Event): void {
    this.status.set((event.target as HTMLSelectElement).value as Staleness | 'all');
    this.paging.reset();
  }

  protected onCommissionedFilter(event: Event): void {
    this.commissionedFilter.set((event.target as HTMLSelectElement).value as CommissionedFilter);
    this.paging.reset();
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
