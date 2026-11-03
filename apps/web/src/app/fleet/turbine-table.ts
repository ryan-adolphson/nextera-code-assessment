import { DecimalPipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatIconButton } from '@angular/material/button';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatSlideToggle, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatSort, MatSortHeader, Sort } from '@angular/material/sort';
import { RouterLink } from '@angular/router';
import { secondsToMilliseconds } from 'date-fns';
import { AppTimePipe } from '../core/app-time.pipe';
import { AuthStore } from '../core/auth/auth.store';
import { TimeZoneSettings } from '../core/time-zone';
import { FleetStore, FleetTurbine } from './fleet.store';
import { STALENESS_LABELS, STALENESS_ORDER, Staleness } from './staleness';
import { FarmPill } from '../ui/farm-pill';
import { paginate } from '../ui/paging';
import { RowGlide } from '../ui/row-glide';
import { TABLE_IMPORTS } from '../ui/table';
import { StalenessBadge } from './staleness-badge';

export type TurbineSortKey =
  'id' | 'farm' | 'status' | 'commissioned' | 'power' | 'wind' | 'gearbox' | 'time';
type SortValue = string | number | null;
/** A row order: each turbine's position in the sorted list. */
type RowOrder = ReadonlyMap<string, number>;

/** During a burst of live readings: the row order follows once this long has passed without one… */
export const ORDER_QUIET_MS = secondsToMilliseconds(1);
/** …or after this long at most, if the burst goes on. */
export const ORDER_MAX_HOLD_MS = secondsToMilliseconds(3);

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
    label: 'Last reading',
    value: (t) => t.latest?.timestamp ?? null,
  },
];

/**
 * The turbines table shared by /turbines (every turbine) and the farm page (one farm's turbines,
 * without the Farm column): filters (text, status, commissioning, a "Hide turbines with no data"
 * switch, on by default, for turbines that have never reported) with the match count, then a
 * Material table in a `TableFrame` with the farm's id pill, the status pill, Commissioned (a switch
 * for owners and admins, a check mark or X for viewers), the latest values and the last reading time; sortable by any column (default: last reading, newest first;
 * turbines without readings last; ties by id), 25 rows per page, live (`data-updated` flash on the
 * updated rows). Each turbine id links to its turbine page.
 *
 * Live updates stay calm: the cells and the filters follow every reading, but the rows keep their
 * order during a burst and glide to the new one once it settles (`ORDER_QUIET_MS`,
 * `ORDER_MAX_HOLD_MS`, `RowGlide`). A change of sort, filter or turbine list applies at once.
 *
 * Owners and admins can change a turbine's commissioned state in its cell (optimistic, through
 * `FleetStore.setCommissioned`). That is not a live reading: no flash and no glide. If it moves the
 * row, focus follows to the row's switch; if the row leaves the page, to the match count.
 */
@Component({
  selector: 'app-turbine-table',
  // Passes the window-high flex column through (route data `fillViewport` on /turbines): the
  // filters keep their height, the table frame takes what is left and scrolls its rows.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  imports: [
    AppTimePipe,
    DecimalPipe,
    FarmPill,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatSlideToggle,
    MatSort,
    MatSortHeader,
    MatSuffix,
    RouterLink,
    RowGlide,
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
  protected readonly tz = inject(TimeZoneSettings);
  private readonly auth = inject(AuthStore);
  /** Hides the commissioned control from viewers; the API enforces the role too. */
  protected readonly canCommission = computed(() => this.auth.can('owner'));
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
    key: 'time',
    dir: 'desc',
  });
  protected readonly query = signal('');
  protected readonly status = signal<Staleness | 'all'>('all');
  protected readonly commissionedFilter = signal<CommissionedFilter>('all');

  /** The switch's own setting; it comes back when the status filter lets go of it. */
  private readonly hideNoData = signal(true);
  /** Choosing "No readings yet" asks for exactly those turbines, so it overrides the switch. */
  protected readonly hidesNoData = computed(() => this.hideNoData() && this.status() !== 'empty');

  /** Turbines matching the text, status and commissioning filters (the switch not applied). */
  private readonly matching = computed(() => {
    const query = this.query().trim().toLowerCase();
    const status = this.status();
    const commissioned = this.commissionedFilter();
    const searched = (t: FleetTurbine) =>
      this.searchesFarms() ? [t.id, t.farmId, t.farmName] : [t.id];
    return this.turbines().filter(
      (t) =>
        (status === 'all' || t.staleness === status) &&
        (commissioned === 'all' || t.commissioned === (commissioned === 'yes')) &&
        (!query || searched(t).some((s) => s.toLowerCase().includes(query))),
    );
  });

  /** How many turbines the other filters would show that the switch hides right now. */
  protected readonly hiddenNoData = computed(() =>
    this.hidesNoData() ? this.matching().filter((t) => t.staleness === 'empty').length : 0,
  );

  /**
   * What the user chose to see. When it changes, the order applies at once; the turbine ids are part
   * of it (another farm, a fleet reload), so the order always ranks every turbine in `turbines`.
   * So are the commissioned values while the sort or a filter looks at them: a change there acts
   * like a filter change, at once and without a glide. Otherwise it can't move a row.
   */
  private readonly listKey = computed(() =>
    JSON.stringify([
      this.turbines().map((t) => t.id),
      this.sort().key === 'commissioned' || this.commissionedFilter() !== 'all'
        ? this.turbines().map((t) => t.commissioned)
        : null,
      this.sort(),
      this.query(),
      this.status(),
      this.commissionedFilter(),
      this.hidesNoData(),
    ]),
  );

  /**
   * The order shown: of all turbines, not just the matching ones, so a row that starts matching
   * during a burst (e.g. its first reading, with the switch on) shows at once in its last known
   * place, until the order settles. Live readings only change it through `settleOrder`.
   */
  private readonly order = linkedSignal<string, RowOrder>({
    source: this.listKey,
    computation: () => untracked(() => this.currentOrder()),
  });

  protected readonly rows = computed(() => {
    const order = this.order();
    return this.matching()
      .filter((t) => !this.hidesNoData() || t.staleness !== 'empty')
      .sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  });

  private readonly glide = viewChild.required(RowGlide);
  private readonly matchCount = viewChild.required<ElementRef<HTMLElement>>('matchCount');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private quietTimer?: ReturnType<typeof setTimeout>;
  private maxHoldTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Any new `turbines` (a live reading, a clock tick) may change the order: settle it later.
    effect(() => {
      this.turbines();
      untracked(() => this.settleOrderSoon());
    });
    // A list change just applied the order (nothing left to settle; this also covers the first
    // render), and a glide in flight must not run on into it: sorting and filtering are instant.
    effect(() => {
      this.listKey();
      untracked(() => {
        this.clearOrderTimers();
        this.glide().cancel();
        this.keepSwitchFocus();
      });
    });
    inject(DestroyRef).onDestroy(() => {
      this.clearOrderTimers();
      this.store.commissionedError.set(null); // about this table's control: not for the next page
    });
  }

  /** The empty table's message: says when it is only the switch that hides the turbines. */
  protected readonly noRowsMessage = computed(() => {
    const hidden = this.hiddenNoData();
    if (hidden === 0) return 'No turbines match the filters.';
    return hidden === 1
      ? '1 turbine with no readings yet is hidden. Turn off “Hide turbines with no data” to show it.'
      : `${hidden} turbines with no readings yet are hidden. Turn off “Hide turbines with no data” to show them.`;
  });

  /** Rows on the current page (Material paginator; 25 per page by default). */
  protected readonly paging = paginate(this.rows, 25);

  /** The rows' order by the current sort (no value last, ties by id) and latest values. */
  private currentOrder(): RowOrder {
    const { key, dir } = this.sort();
    const column = COLUMNS.find((c) => c.key === key)!;
    const value = (t: FleetTurbine) => column.value(t);
    const sorted = [...this.turbines()].sort(
      (a, b) => compare(value(a), value(b), dir) || a.id.localeCompare(b.id),
    );
    return new Map(sorted.map((t, position) => [t.id, position]));
  }

  /**
   * Called before a list change renders. Moving or removing a row drops the focus inside it to the
   * body, so a focused switch gets it back after the render, scrolled into view. If its row left
   * the page (filtered out, or sorted onto another page) focus goes to the match count, which says
   * what changed: inert, so a held or repeated key can't toggle another turbine.
   */
  private keepSwitchFocus(): void {
    const doc = this.host.ownerDocument;
    const row = doc.activeElement?.closest('[data-testid=commissioned-toggle]')?.closest('tr');
    if (!row) return;
    afterNextRender(
      () => {
        // Only if the change dropped it, not if the row stayed where it was.
        if (doc.activeElement !== doc.body) return;
        const target = row.isConnected
          ? row.querySelector<HTMLElement>('[role=switch]')!
          : this.matchCount().nativeElement;
        target.focus();
      },
      { injector: this.injector },
    );
  }

  private settleOrderSoon(): void {
    clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.settleOrder(), ORDER_QUIET_MS);
    this.maxHoldTimer ??= setTimeout(() => this.settleOrder(), ORDER_MAX_HOLD_MS);
  }

  /** Moves the rows once for the whole burst. Most ticks change nothing: no re-render, no glide. */
  private settleOrder(): void {
    this.clearOrderTimers();
    const next = this.currentOrder();
    const shown = this.order();
    if ([...next].every(([id, position]) => shown.get(id) === position)) return;
    this.glide().reorder(() => this.order.set(next));
  }

  private clearOrderTimers(): void {
    clearTimeout(this.quietTimer);
    clearTimeout(this.maxHoldTimer);
    this.maxHoldTimer = undefined;
  }

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

  /**
   * The switch asks for the opposite value; the store decides what it shows. So the switch goes
   * back to the store's value first, and follows it through its binding (also on a rollback).
   */
  protected onCommissionedToggle(turbine: FleetTurbine, event: MatSlideToggleChange): void {
    const commissioned = event.checked;
    event.source.checked = turbine.commissioned;
    this.store.setCommissioned(turbine.id, commissioned);
  }

  protected onHideNoData(event: MatSlideToggleChange): void {
    this.hideNoData.set(event.checked);
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
