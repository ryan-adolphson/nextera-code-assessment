import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { FormField, FormRoot, form, required, validate } from '@angular/forms/signals';
import { MatAutocomplete, MatAutocompleteTrigger } from '@angular/material/autocomplete';
import { MatButton } from '@angular/material/button';
import { MatOptgroup, MatOption, provideNativeDateAdapter } from '@angular/material/core';
import {
  MatDateRangeInput,
  MatDateRangePicker,
  MatDatepickerToggle,
  MatEndDate,
  MatStartDate,
} from '@angular/material/datepicker';
import { MatError, MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { AlertsCell } from '../alerting/alerts-cell';
import { AlertSeries } from '../charts/alert-series';
import { ChartGroup } from '../charts/chart-group';
import { TimeRange } from '../charts/line-chart';
import { NOW } from '../core/clock';
import {
  dayOf,
  dayRange,
  defaultDays,
  lastUtcDay,
  pickerDate,
  rangeError,
  utcDayOf,
} from '../core/utc-days';
import { Telemetry } from '../fleet/fleet.model';
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
 * /reporting (proof of concept): a telemetry report for a farm or a turbine over whole UTC days.
 * Pick the scope (Material autocomplete, Farms / Turbines) and the days (Material date range picker,
 * required, at most 31 days), then run it: one GET /api/reports/telemetry returns every reading
 * with its alerts. Shows a summary, one chart per metric (a farm: power summed, the rest averaged
 * per time) plus an alerts chart, the readings table, and a browser-built CSV download.
 */
@Component({
  selector: 'app-reporting-page',
  imports: [
    AlertsCell,
    DatePipe,
    DecimalPipe,
    ChartGroup,
    MatAutocomplete,
    MatAutocompleteTrigger,
    MatButton,
    MatDateRangeInput,
    MatDateRangePicker,
    MatDatepickerToggle,
    MatEndDate,
    MatError,
    MatFormField,
    MatInput,
    MatLabel,
    MatOptgroup,
    MatOption,
    MatStartDate,
    MatSuffix,
    FormField,
    FormRoot,
    StatTile,
    TABLE_IMPORTS,
  ],
  templateUrl: './reporting-page.html',
  // The datepicker's DateAdapter: native Dates (local midnights, read as UTC days by utcDayOf).
  providers: [provideNativeDateAdapter()],
})
export class ReportingPage {
  private readonly api = inject(ReportApi);
  private readonly fleet = inject(FleetStore);

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
      const start = dayOf(value().start);
      const end = dayOf(value().end);
      if (start === null || end === null) return undefined;
      const message = rangeError(start, end);
      return message ? { kind: 'range', message } : undefined;
    });
  });
  /** The range error (on the form itself, not a field), once a field was touched or changed. */
  protected readonly rangeMessage = computed(() => {
    const state = this.reportForm();
    if (!state.touched() && !state.dirty()) return null;
    return state.errors().find((e) => e.kind === 'range')?.message ?? null;
  });
  /** No future days to pick: the last selectable day is today (UTC). */
  protected readonly maxDate = pickerDate(defaultDays(inject(NOW)()).end);

  private readonly options = computed(() =>
    scopeOptions(this.fleet.farms(), this.fleet.turbines()),
  );
  /** The autocomplete's `displayWith`: a chosen option's label, or the typed text. */
  protected readonly displayOption = (value: ScopeValue): string =>
    typeof value === 'string' ? value : (value?.label ?? '');
  /** What was typed (or the chosen option's label), to filter the options by. */
  private readonly typed = computed(() => this.displayOption(this.model().scope));
  /** The autocomplete's groups, filtered by what was typed. */
  protected readonly filtered = computed(() => ({
    farms: filterOptions(this.options().farms, this.typed()),
    turbines: filterOptions(this.options().turbines, this.typed()),
  }));

  /** The latest run's report (an earlier run's late answer is dropped); kept when a run fails. */
  private readonly reportLoad = latestLoad(
    (request: ReportRequest) => this.api.telemetry(request),
    () => this.paging.reset(), // a new report: the chart group resets its zoom too
  );
  protected readonly report = this.reportLoad.value;
  protected readonly loading = this.reportLoad.loading;
  protected readonly failed = this.reportLoad.failed;

  // --- What the report shows ---------------------------------------------------------------
  protected readonly readings = computed(() => this.report()?.readings ?? []);
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
    return report ? lastUtcDay(report.to) : null;
  });

  protected readonly paging = paginate(this.readings, 50, [25, 50, 100, 250]);
  protected readonly columns = computed(() => [
    'measured',
    ...(this.report()?.scope.kind === 'farm' ? ['turbine'] : []),
    ...METRICS.map((m) => m.key),
    'alerts',
  ]);
  protected readonly metrics = METRICS;
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
    this.reportLoad.run({
      kind: option.kind,
      id: option.id,
      ...dayRange(utcDayOf(start!), utcDayOf(end!)),
    });
  }

  protected retry(): void {
    this.reportLoad.retry();
  }

  protected download(): void {
    const report = this.report();
    if (report) downloadCsv(csvFileName(report), toCsv(report));
  }
}
