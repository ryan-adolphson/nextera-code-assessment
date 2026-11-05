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
  untracked,
  viewChild,
} from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatSlideToggle, MatSlideToggleChange } from '@angular/material/slide-toggle';
import { MatSort, MatSortHeader, Sort } from '@angular/material/sort';
import { RouterLink } from '@angular/router';
import { AppTimePipe } from '../core/app-time.pipe';
import { AuthStore } from '../core/auth/auth.store';
import { TimeZoneSettings } from '../core/time-zone';
import { TurbineSortKey } from './fleet.model';
import {
  CommissionedFilter,
  StatusFilter,
  TurbinePageStore,
  TurbineRow,
} from './turbine-page.store';
import { FarmPill } from '../ui/farm-pill';
import { RowGlide } from '../ui/row-glide';
import { TABLE_IMPORTS } from '../ui/table';
import { StalenessBadge } from './staleness-badge';

/** The table's columns: the server's sort keys, and the status (not sortable: the API has no such sort). */
export type TurbineColumn = TurbineSortKey | 'status';

interface Column {
  key: TurbineColumn;
  /** Numeric columns: the latest reading's field and its number format. */
  reading?: { field: 'powerOutputKw' | 'windSpeedMs' | 'gearboxTempC'; format: string };
  label: string;
}
type NumericColumn = Column & { reading: NonNullable<Column['reading']> };

/** The columns, in table order. */
const COLUMNS: Column[] = [
  { key: 'id', label: 'Turbine' },
  { key: 'farm', label: 'Farm' },
  { key: 'status', label: 'Status' },
  { key: 'commissioned', label: 'Commissioned' },
  { key: 'power', label: 'Power (kW)', reading: { field: 'powerOutputKw', format: '1.0-0' } },
  { key: 'wind', label: 'Wind (m/s)', reading: { field: 'windSpeedMs', format: '1.1-1' } },
  { key: 'gearbox', label: 'Gearbox (°C)', reading: { field: 'gearboxTempC', format: '1.1-1' } },
  { key: 'time', label: 'Last reading' },
];

/**
 * The turbines table shared by /turbines (every turbine) and the farm page (one farm's turbines,
 * `farmId`, without the Farm column), served page by page by the API (`TurbinePageStore`, one per
 * table): filters (text, status, commissioning, a "Hide turbines with no data" switch, on by
 * default, for turbines that have never reported) with the total, then a Material table in a
 * `TableFrame` with the farm's id pill, the status pill, Commissioned (a switch for owners and
 * admins, a check mark or X for viewers), the latest values and the last reading time; sorted by
 * the server (default: last reading, newest first; no reading last; ties by id; power, wind and
 * gearbox only with a farm), 25 rows per page with next/previous. Live: the visible rows update
 * once a second (`data-updated` flash); when the sort is by a value readings change, the rows glide
 * to their new places (`RowGlide`). Each turbine id links to its turbine page.
 *
 * Owners and admins can change a turbine's commissioned state in its cell (optimistic, through
 * `TurbinePageStore.setCommissioned`). If it moves the row, focus follows to the row's switch; if
 * the row leaves the page, to the total.
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
    MatButton,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatProgressSpinner,
    MatSlideToggle,
    MatSort,
    MatSortHeader,
    MatSuffix,
    RouterLink,
    RowGlide,
    StalenessBadge,
    TABLE_IMPORTS,
  ],
  providers: [TurbinePageStore],
  templateUrl: './turbine-table.html',
})
export class TurbineTable {
  /** The farm whose turbines to list; null (default) = the whole fleet. */
  readonly farmId = input<string | null>(null);
  /**
   * Columns to leave out, e.g. `['farm']` on a farm page. Without the farm column, the text filter
   * says it searches turbine ids (the server still matches farm id and name too).
   */
  readonly hiddenColumns = input<readonly TurbineColumn[]>([]);

  protected readonly store = inject(TurbinePageStore);
  protected readonly tz = inject(TimeZoneSettings);
  private readonly auth = inject(AuthStore);
  /** Hides the commissioned control from viewers; the API enforces the role too. */
  protected readonly canCommission = computed(() => this.auth.can('owner'));
  protected readonly columnKeys = computed(() =>
    COLUMNS.map((c) => c.key).filter((key) => !this.hiddenColumns().includes(key)),
  );
  protected readonly numericColumns = COLUMNS.filter((c): c is NumericColumn => !!c.reading);
  protected readonly searchesFarms = computed(() => !this.hiddenColumns().includes('farm'));
  protected readonly trackById = (_: number, t: TurbineRow) => t.id;
  protected readonly commissionedFilters: { value: CommissionedFilter; label: string }[] = [
    { value: 'all', label: 'Any' },
    { value: 'yes', label: 'Commissioned' },
    { value: 'no', label: 'Not commissioned' },
  ];
  /** The server's three states; the pill keeps the four client-clock levels. */
  protected readonly statuses: { value: StatusFilter; label: string }[] = [
    { value: 'reporting', label: 'Reporting' },
    { value: 'stale', label: 'No recent data' },
    { value: 'no_data', label: 'No readings yet' },
  ];

  private readonly glide = viewChild.required(RowGlide);
  private readonly matchCount = viewChild.required<ElementRef<HTMLElement>>('matchCount');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);

  constructor() {
    effect(() => {
      const farmId = this.farmId();
      untracked(() => this.store.setScope(farmId));
    });
    this.store.reorderWith = (change) => this.glide().reorder(change);
    // Rows come and go with the page, a sort or a filter: keep a focused switch (see below).
    effect(() => {
      this.store.rows();
      untracked(() => this.keepSwitchFocus());
    });
    inject(DestroyRef).onDestroy(() => {
      this.store.reorderWith = null;
      this.store.commissionedError.set(null); // about this table's control: not for the next page
    });
  }

  /** The empty table's message. */
  protected readonly noRowsMessage = computed(() =>
    this.store.hidesNoData()
      ? 'No turbines match the filters. Turbines with no readings yet are hidden: turn off “Hide turbines with no data” to show them.'
      : 'No turbines match the filters.',
  );

  /**
   * Called before a list change renders. Moving or removing a row drops the focus inside it to the
   * body, so a focused switch gets it back after the render, scrolled into view. If its row left
   * the page (filtered out, or sorted onto another page) focus goes to the total, which says what
   * changed: inert, so a held or repeated key can't toggle another turbine.
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

  /**
   * MatSort with `matSortDisableClear`: the same column reverses the order, another column sorts
   * by it ascending. Back to the first page.
   */
  protected onSort(sort: Sort): void {
    this.store.setSort({ key: sort.active as TurbineSortKey, dir: sort.direction || 'asc' });
  }

  protected onQuery(event: Event): void {
    this.store.setQuery((event.target as HTMLInputElement).value);
  }

  /** The search field's clear button: empty the text filter and keep typing where it was. */
  protected clearQuery(input: HTMLInputElement): void {
    this.store.clearQuery();
    input.focus();
  }

  protected onStatus(event: Event): void {
    this.store.setStatus((event.target as HTMLSelectElement).value as StatusFilter);
  }

  protected onCommissionedFilter(event: Event): void {
    this.store.setCommissionedFilter(
      (event.target as HTMLSelectElement).value as CommissionedFilter,
    );
  }

  /**
   * The switch asks for the opposite value; the store decides what it shows. So the switch goes
   * back to the store's value first, and follows it through its binding (also on a rollback).
   */
  protected onCommissionedToggle(turbine: TurbineRow, event: MatSlideToggleChange): void {
    const commissioned = event.checked;
    event.source.checked = turbine.commissioned;
    this.store.setCommissioned(turbine.id, commissioned);
  }

  protected onHideNoData(event: MatSlideToggleChange): void {
    this.store.setHideNoData(event.checked);
  }
}
