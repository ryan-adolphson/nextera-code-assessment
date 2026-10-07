import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
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
import { MatTooltip } from '@angular/material/tooltip';
import { Subject, catchError, map, of, startWith, switchMap, tap } from 'rxjs';
import { AlertLevelBadge } from '../alerting/alert-level-badge';
import { describeTriggerWithLevel } from '../alerting/alert-text';
import { LineChart, TimeRange } from '../charts/line-chart';
import { NOW } from '../core/clock';
import { dayRange, defaultDays, pickerDate, rangeError, utcDayOf } from '../core/utc-days';
import { Telemetry } from '../fleet/fleet.model';
import { FleetStore } from '../fleet/fleet.store';
import { METRICS } from '../fleet/metrics';
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
import { ReportApi, ReportRequest, TelemetryReport } from './report-api.service';

/** The scope field holds the chosen option, or the text typed so far (not a choice yet). */
type ScopeValue = ScopeOption | string | null;

/** A farm or turbine picked from the list (typed text alone doesn't count). */
function chosenOption(control: AbstractControl<ScopeValue>): ValidationErrors | null {
  return typeof control.value === 'string' && control.value ? { chooseOption: true } : null;
}

/** The days form a valid range (the API's checks); missing days are `required`'s job. */
function validRange(group: AbstractControl): ValidationErrors | null {
  const start = dayOf(group.get('start')?.value ?? null);
  const end = dayOf(group.get('end')?.value ?? null);
  if (start === null || end === null) return null;
  const message = rangeError(start, end);
  return message ? { range: message } : null;
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
    AlertLevelBadge,
    DatePipe,
    DecimalPipe,
    LineChart,
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
    MatTooltip,
    ReactiveFormsModule,
    StatTile,
    TABLE_IMPORTS,
  ],
  templateUrl: './reporting-page.html',
  // The datepicker's DateAdapter: native Dates (local midnights, read as UTC days by utcDayOf).
  providers: [provideNativeDateAdapter()],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportingPage {
  private readonly api = inject(ReportApi);
  private readonly fleet = inject(FleetStore);

  protected readonly form = new FormGroup(
    {
      scope: new FormControl<ScopeValue>(null, [Validators.required, chosenOption]),
      start: new FormControl<Date | null>(null, Validators.required),
      end: new FormControl<Date | null>(null, Validators.required),
    },
    { validators: validRange },
  );
  /** No future days to pick: the last selectable day is today (UTC). */
  protected readonly maxDate = pickerDate(defaultDays(inject(NOW)()).end);

  private readonly options = computed(() =>
    scopeOptions(this.fleet.farms(), this.fleet.turbines()),
  );
  private readonly typed = toSignal(
    this.form.controls.scope.valueChanges.pipe(
      startWith(this.form.controls.scope.value),
      map((value) => (typeof value === 'string' ? value : (value?.label ?? ''))),
    ),
    { initialValue: '' },
  );
  /** The autocomplete's groups, filtered by what was typed. */
  protected readonly filtered = computed(() => ({
    farms: filterOptions(this.options().farms, this.typed()),
    turbines: filterOptions(this.options().turbines, this.typed()),
  }));
  protected readonly displayOption = (value: ScopeValue): string =>
    typeof value === 'string' ? value : (value?.label ?? '');

  protected readonly report = signal<TelemetryReport | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  private lastRequest: ReportRequest | null = null;
  private readonly requests = new Subject<ReportRequest>();

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
  protected readonly alertChart = computed(() => this.series());
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
    return report ? new Date(Date.parse(report.to) - 24 * 60 * 60_000).toISOString() : null;
  });
  /** Shared crosshair and zoom across the charts, like the turbine page. */
  protected readonly hoverT = signal<number | null>(null);
  protected readonly view = signal<TimeRange | null>(null);

  protected readonly paging = paginate(this.readings, 50, [25, 50, 100, 250]);
  protected readonly columns = computed(() => [
    'measured',
    ...(this.report()?.scope.kind === 'farm' ? ['turbine'] : []),
    ...METRICS.map((m) => m.key),
    'alerts',
  ]);
  protected readonly metrics = METRICS;
  protected readonly trackById = (_: number, r: Telemetry) => r.id;

  constructor() {
    this.requests
      .pipe(
        tap((request) => {
          this.lastRequest = request;
          this.loading.set(true);
          this.failed.set(false);
        }),
        switchMap((request) =>
          this.api.telemetry(request).pipe(
            map((report): TelemetryReport | null => report),
            catchError(() => of(null)),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((report) => {
        if (report) {
          this.report.set(report);
          this.view.set(null);
          this.hoverT.set(null);
          this.paging.reset();
        } else {
          this.failed.set(true);
        }
        this.loading.set(false);
      });
  }

  /** Runs the report for the chosen scope and days (or shows what is missing). */
  protected run(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { scope, start, end } = this.form.getRawValue();
    const option = scope as ScopeOption;
    this.requests.next({
      kind: option.kind,
      id: option.id,
      ...dayRange(utcDayOf(start!), utcDayOf(end!)),
    });
  }

  protected retry(): void {
    if (this.lastRequest) this.requests.next(this.lastRequest);
  }

  protected download(): void {
    const report = this.report();
    if (report) downloadCsv(csvFileName(report), toCsv(report));
  }

  /** The rules a reading triggered, one per line (the alerts cell's tooltip). */
  protected alertLines(reading: Telemetry): string {
    return reading.alerts.map((rule) => describeTriggerWithLevel(reading, rule)).join('\n');
  }
}

/** A picked Date as its UTC day, or null (not chosen, or an invalid typed date). */
function dayOf(date: Date | null): number | null {
  return date && !Number.isNaN(date.getTime()) ? utcDayOf(date) : null;
}
