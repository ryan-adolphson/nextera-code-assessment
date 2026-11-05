import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { Field, FormField, FormRoot, form, required, validate } from '@angular/forms/signals';
import { MatAutocomplete, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatButton } from '@angular/material/button';
import {
  ErrorStateMatcher,
  MatOptgroup,
  MatOption,
  provideNativeDateAdapter,
} from '@angular/material/core';
import {
  MatDateRangeInput,
  MatDateRangePicker,
  MatDatepickerToggle,
  MatEndDate,
  MatStartDate,
} from '@angular/material/datepicker';
import { MatError, MatFormField, MatHint, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { errorMessage, statusOf } from '../core/http-errors';
import { AlertsCell } from '../alerting/alerts-cell';
import { AlertSeries } from '../charts/alert-series';
import { ChartGroup } from '../charts/chart-group';
import { ChartSkeleton, ChartSkeletonCard } from '../charts/chart-skeleton';
import { TimeRange } from '../charts/line-chart';
import { AppTimePipe } from '../core/app-time.pipe';
import { NOW } from '../core/clock';
import { dayOf, dayRange, defaultDays, lastDay, pickerDate, rangeError } from '../core/days';
import { TimeZoneSettings } from '../core/time-zone';
import { Telemetry } from '../fleet/fleet.model';
import { FleetApi } from '../fleet/fleet-api.service';
import { FleetStore } from '../fleet/fleet.store';
import { METRICS } from '../fleet/metrics';
import { latestLoad } from '../ui/latest-load';
import { paginate } from '../ui/paging';
import { StatTile } from '../ui/stat-tile';
import { TABLE_IMPORTS } from '../ui/table';
import {
  ScopeOption,
  csvFileName,
  downloadCsv,
  filterOptions,
  reportSeries,
  scopeOptions,
  toCsv,
} from './report';
import { ReportApi, ReportRequest } from './report-api.service';

/** The scope field holds the chosen option, or the text typed so far (not a choice yet). */
type ScopeValue = ScopeOption | string | null;

/** The report form's model: the scope and the picked days (local-midnight Dates, null if empty). */
interface ReportModel {
  scope: ScopeValue;
  start: Date | null;
  end: Date | null;
}

/**
 * /reporting (proof of concept): a telemetry report for a farm or a turbine over whole days in the
 * zone shown (Settings: UTC or local; a zone change re-runs a shown report for the same days).
 * Pick the scope (Material autocomplete, Farms / Turbines) and the days (Material date range picker,
 * required, at most 31 days), then run it: one GET /api/reports/telemetry returns every reading
 * with its alerts. Shows a summary, one chart per metric (a farm: power summed, the rest averaged
 * per time) plus an alerts chart, the readings table, and a browser-built CSV download.
 */
@Component({
  selector: 'app-reporting-page',
  imports: [
    AlertsCell,
    AppTimePipe,
    DecimalPipe,
    ChartGroup,
    ChartSkeleton,
    MatAutocomplete,
    MatAutocompleteTrigger,
    MatButton,
    MatDateRangeInput,
    MatDateRangePicker,
    MatDatepickerToggle,
    MatEndDate,
    MatError,
    MatFormField,
    MatHint,
    MatInput,
    MatLabel,
    MatOptgroup,
    MatOption,
    MatProgressSpinner,
    MatStartDate,
    MatSuffix,
    FormField,
    FormRoot,
    StatTile,
    TABLE_IMPORTS,
  ],
  templateUrl: './reporting-page.html',
  // The datepicker's DateAdapter: native Dates (browser-local midnights; their calendar dates name
  // days in the zone shown, see core/days.ts).
  providers: [provideNativeDateAdapter()],
})
export class ReportingPage {
  private readonly api = inject(ReportApi);
  private readonly fleet = inject(FleetStore);
  protected readonly tz = inject(TimeZoneSettings);

  private readonly model = signal<ReportModel>({ scope: null, start: null, end: null });
  protected readonly reportForm = form(this.model, (report) => {
    required(report.scope);
    // A farm or turbine picked from the list (typed text alone doesn't count).
    validate(report.scope, ({ value }) => {
      const scope = value();
      return typeof scope === 'string' && scope ? { kind: 'chooseOption' } : undefined;
    });
    required(report.start);
    required(report.end);
    // The days form a valid range (the API's checks); missing days are `required`'s job.
    validate(report, ({ value }) => {
      const zone = this.tz.zone();
      const start = dayOf(value().start, zone);
      const end = dayOf(value().end, zone);
      if (start === null || end === null) return undefined;
      const message = rangeError(start, end, zone);
      return message ? { kind: 'range', message } : undefined;
    });
  });
  /**
   * The calendar is open: picking a start day clears (and touches) the end day, so the range's
   * errors wait until it closes.
   */
  private readonly picking = signal(false);
  /** The date inputs' error state: Material's default (invalid and touched), not while picking. */
  protected readonly rangeErrorState = computed(() => new RangeErrorState(this.picking()));
  /** The range error (on the form itself, not a field), once a field was touched or changed. */
  protected readonly rangeMessage = computed(() => {
    const state = this.reportForm();
    if (this.picking() || (!state.touched() && !state.dirty())) return null;
    return state.errors().find((e) => e.kind === 'range')?.message ?? null;
  });
  private readonly now = inject(NOW);
  /** No future days to pick: the last selectable day is today (in the zone shown). */
  protected readonly maxDate = computed(() =>
    pickerDate(defaultDays(this.now(), this.tz.zone()).end, this.tz.zone()),
  );

  private readonly fleetApi = inject(FleetApi);
  /** The turbines matching the typed text, from the server (the fleet is too big to list). */
  private readonly turbineSearch = latestLoad((q: string) => this.fleetApi.searchTurbines(q));
  /**
   * Farms come from the summaries the shell holds; turbines are searched on the server as the
   * user types (UI seam: `turbineSearching` for a spinner, `turbineSearchFailed` for a hint).
   */
  private readonly options = computed(() =>
    scopeOptions(this.fleet.farms(), this.turbineSearch.value() ?? []),
  );
  protected readonly turbineSearching = this.turbineSearch.loading;
  protected readonly turbineSearchFailed = this.turbineSearch.failed;
  /** A search has answered (the turbines listed may belong to text typed a moment ago). */
  protected readonly turbineSearched = computed(() => this.turbineSearch.value() !== null);
  /** The autocomplete's `displayWith`: a chosen option's label, or the typed text. */
  protected readonly displayOption = (value: ScopeValue): string =>
    typeof value === 'string' ? value : (value?.label ?? '');
  /** What was typed (or the chosen option's label), to filter the options by. */
  private readonly typed = computed(() => this.displayOption(this.model().scope));
  /** The autocomplete's groups: farms filtered by what was typed, turbines as the server found them. */
  protected readonly filtered = computed(() => ({
    farms: filterOptions(this.options().farms, this.typed()),
    turbines: this.searchText() ? this.options().turbines : [],
  }));
  /** The typed text to search turbines for (nothing once an option is chosen or for an empty field). */
  protected readonly searchText = computed(() => {
    const scope = this.model().scope;
    return typeof scope === 'string' ? scope.trim() : '';
  });

  /** The latest run's report (an earlier run's late answer is dropped); kept when a run fails. */
  private readonly reportLoad = latestLoad(
    (request: ReportRequest) => this.api.telemetry(request),
    () => this.paging.reset(), // a new report: the chart group resets its zoom too
  );
  protected readonly report = this.reportLoad.value;
  protected readonly loading = this.reportLoad.loading;
  protected readonly failed = this.reportLoad.failed;
  /**
   * Why the run failed. A 400 (a range or a size the API refuses, e.g. a farm report over 100,000
   * readings) carries a clear message to show as is; retrying it would fail again, so it has no
   * Retry. Anything else gets the generic text.
   */
  protected readonly rejection = computed(() => {
    const error = this.reportLoad.error();
    return statusOf(error) === 400 ? errorMessage(error) : null;
  });

  // --- What the report shows ---------------------------------------------------------------
  protected readonly readings = computed(() => this.report()?.readings ?? []);
  /** A report with readings is shown: its charts and table appear. */
  protected readonly hasCharts = computed(() => this.readings().length > 0);
  private readonly series = computed(() => {
    const report = this.report();
    return report ? reportSeries(report) : null;
  });
  protected readonly charts = computed(() => {
    const series = this.series();
    return series ? METRICS.map((m) => ({ ...m, points: series.metrics[m.key] })) : [];
  });
  protected readonly alertChart = computed((): AlertSeries | null => {
    const series = this.series();
    return series ? { points: series.alerts, markers: series.markers } : null;
  });
  protected readonly domain = computed((): TimeRange | null => {
    const report = this.report();
    return report ? { from: Date.parse(report.from), to: Date.parse(report.to) } : null;
  });
  protected readonly summary = computed(() => {
    const readings = this.readings();
    return {
      readings: readings.length,
      turbines: new Set(readings.map((r) => r.turbineId)).size,
      alerts: readings.reduce((n, r) => n + r.alerts.length, 0),
    };
  });
  /** The last day of the report ([from, to) covers whole days; to is the day after). */
  protected readonly lastDay = computed(() => {
    const report = this.report();
    return report ? lastDay(report.to, this.tz.zone()) : null;
  });

  protected readonly paging = paginate(this.readings, 50, [25, 50, 100, 250]);

  private searchTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Search turbines 250 ms after the last keystroke; a newer search replaces an older one.
    effect(() => {
      const text = this.searchText();
      clearTimeout(this.searchTimer);
      if (!text) return;
      this.searchTimer = setTimeout(() => untracked(() => this.turbineSearch.run(text)), 250);
    });
    inject(DestroyRef).onDestroy(() => clearTimeout(this.searchTimer));
    // A zone change (Settings) re-runs a report that was run, for the same calendar days in the
    // new zone (the form keeps the picked dates); nothing is run before the first Run.
    let zone = this.tz.zone();
    effect(() => {
      const current = this.tz.zone();
      if (current === zone) return;
      zone = current;
      untracked(() => {
        if (this.report() || this.loading()) this.run();
      });
    });
  }
  protected readonly columns = computed(() => [
    'measured',
    ...(this.report()?.scope.kind === 'farm' ? ['turbine'] : []),
    ...METRICS.map((m) => m.key),
    'alerts',
  ]);
  protected readonly metrics = METRICS;
  /** The report charts' size before their chunk has loaded: a line chart per metric + alerts. */
  protected readonly chartSkeleton: ChartSkeletonCard[] = [
    ...METRICS.map((metric) => ({ title: metric.title, lines: 0 })),
    { title: 'Alert rules triggered', lines: 1 },
  ];
  protected readonly trackById = (_: number, r: Telemetry) => r.id;

  /**
   * Runs the report for the chosen scope and days (or shows what is missing). `[formRoot]` keeps
   * the browser from submitting the form; this is its `(submit)` handler.
   */
  protected run(): void {
    if (this.reportForm().invalid()) {
      this.reportForm().markAsTouched();
      return;
    }
    const { scope, start, end } = this.model();
    const option = scope as ScopeOption;
    const zone = this.tz.zone();
    this.reportLoad.run({
      kind: option.kind,
      id: option.id,
      ...dayRange(dayOf(start, zone)!, dayOf(end, zone)!, zone),
    });
  }

  protected retry(): void {
    this.reportLoad.retry();
  }

  /** The calendar opened or closed (`picking`). */
  protected onPicking(open: boolean): void {
    this.picking.set(open);
  }

  protected download(): void {
    const report = this.report();
    if (report) downloadCsv(csvFileName(report, this.tz.zone()), toCsv(report));
  }
}

/** Material's default error state (invalid and touched), except while the calendar is open. */
class RangeErrorState extends ErrorStateMatcher {
  constructor(private readonly picking: boolean) {
    super();
  }

  override isErrorState(...args: Parameters<ErrorStateMatcher['isErrorState']>): boolean {
    return !this.picking && super.isErrorState(...args);
  }

  override isSignalErrorState(field: Field<unknown> | null): boolean {
    // Material's default for a Signal Forms field: invalid and touched.
    return !this.picking && !!field && field().invalid() && field().touched();
  }
}
