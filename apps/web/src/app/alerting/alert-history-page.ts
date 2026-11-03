import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { provideNativeDateAdapter } from '@angular/material/core';
import {
  MatDateRangeInput,
  MatDateRangePicker,
  MatDatepickerToggle,
  MatEndDate,
  MatStartDate,
} from '@angular/material/datepicker';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import { AppTimePipe } from '../core/app-time.pipe';
import { NOW } from '../core/clock';
import { TimeZoneSettings } from '../core/time-zone';
import { FleetStore } from '../fleet/fleet.store';
import { latestLoad } from '../ui/latest-load';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AlertHistoryApi } from './alert-history-api.service';
import { TurbineAlerts, groupAlertsByTurbine } from './alert-history';
import {
  DayRange,
  dayOf,
  dayRange,
  defaultDays,
  pickerDate,
  rangeError,
  sameRange,
} from '../core/days';
import { AlertingTabs } from './alerting-tabs';
import { AlertChips } from './alert-chips';
import { AlertLevelBadge } from './alert-level-badge';

/**
 * /alerting/history: the readings that triggered alert rules over whole days chosen with a
 * Material date range picker (GET /api/alerts for [start 00:00, the day after end 00:00)), default
 * yesterday and today. A Material table with expandable rows: one summary row per turbine
 * (latest alert, a pill per level with its alert count) that
 * expands to its flagged readings, newest first, each with its rules as chips. 25 turbines per
 * page. Days and times are in the zone shown (Settings: UTC or local); a complete, valid range
 * reloads (once the calendar closes, never halfway through picking), and so does a zone change
 * (the same calendar days, in the new zone).
 */
@Component({
  selector: 'app-alert-history-page',
  imports: [
    AlertChips,
    AlertLevelBadge,
    AlertingTabs,
    AppTimePipe,
    MatButton,
    MatDateRangeInput,
    MatDateRangePicker,
    MatDatepickerToggle,
    MatEndDate,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatLabel,
    MatStartDate,
    MatSuffix,
    RouterLink,
    TABLE_IMPORTS,
  ],
  templateUrl: './alert-history-page.html',
  // The datepicker's DateAdapter: native Dates (browser-local midnights; their calendar dates name
  // days in the zone shown, see core/days.ts).
  providers: [provideNativeDateAdapter()],
  // A column filling the shell's window-high page (route data `fillViewport`): heading, tabs and
  // range keep their height, the table frame takes what is left and scrolls its rows.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
})
export class AlertHistoryPage {
  private readonly api = inject(AlertHistoryApi);
  private readonly fleet = inject(FleetStore);

  private readonly now = inject(NOW);
  protected readonly tz = inject(TimeZoneSettings);
  /** The picked days (the picker's Dates; null while not chosen or not a valid date). */
  protected readonly start = signal<Date | null>(null);
  protected readonly end = signal<Date | null>(null);
  /** No future days to pick: the last selectable day is today (in the zone shown). */
  protected readonly maxDate = computed(() =>
    pickerDate(defaultDays(this.now(), this.tz.zone()).end, this.tz.zone()),
  );
  private readonly startDay = computed(() => dayOf(this.start(), this.tz.zone()));
  private readonly endDay = computed(() => dayOf(this.end(), this.tz.zone()));
  /**
   * The calendar is open: the user may be halfway through picking a range (the picker sets the
   * start, clears the end, then sets the end), so nothing is queried or reported until it closes.
   */
  private readonly picking = signal(false);
  /** Why the chosen days can't be queried (none while picking in the calendar). */
  protected readonly error = computed(() =>
    this.picking() ? null : rangeError(this.startDay(), this.endDay(), this.tz.zone()),
  );
  /** The [from, to) to show: a complete, valid range of the picked days, in the zone shown. */
  private readonly range = computed(
    () => {
      const [start, end] = [this.startDay(), this.endDay()];
      if (this.picking() || this.error() || start === null || end === null) return null;
      return dayRange(start, end, this.tz.zone());
    },
    { equal: sameRange },
  );

  /** The latest range's answer (an earlier range's late answer is dropped); keeps it on failure. */
  private readonly alerts = latestLoad(
    ({ from, to }: { from: string; to: string }) => this.api.list(from, to),
    () => {
      this.expanded.set(new Set());
      this.paging.reset();
    },
  );
  protected readonly readings = computed(() => this.alerts.value() ?? []);
  protected readonly loading = this.alerts.loading;
  protected readonly failed = this.alerts.failed;
  protected readonly turbineCount = computed(
    () => new Set(this.readings().map((r) => r.turbineId)).size,
  );

  /** One summary row per turbine, 25 per page. */
  protected readonly turbines = computed(() =>
    groupAlertsByTurbine(this.readings(), (farmId) => this.farmName(farmId)),
  );
  protected readonly paging = paginate(this.turbines, 25);
  protected readonly columns = ['expand', 'turbine', 'farm', 'latest', 'levels'];
  protected readonly trackTurbine = (_: number, t: TurbineAlerts) => t.turbineId;
  /** The turbines whose rows are expanded (any number at once). */
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());

  constructor() {
    const zone = this.tz.zone();
    const { start, end } = defaultDays(this.now(), zone);
    this.start.set(pickerDate(start, zone));
    this.end.set(pickerDate(end, zone));
    // One request per new complete range: picked or typed days, or a zone change (Settings: the
    // same calendar days in the new zone). The range is null while picking or invalid, so the
    // last results stay; closing the calendar on the range already shown sends nothing.
    let loaded: DayRange | null = null;
    effect(() => {
      const range = this.range();
      if (!range || sameRange(range, loaded)) return;
      loaded = range;
      untracked(() => this.alerts.run(range));
    });
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

  /** The picker changed a day (calendar or typed); a complete, valid range reloads. */
  protected onStart(date: Date | null): void {
    this.start.set(date);
  }

  protected onEnd(date: Date | null): void {
    this.end.set(date);
  }

  /** The calendar opened or closed (`picking`). */
  protected onPicking(open: boolean): void {
    this.picking.set(open);
  }

  /** Loads the last range again (after a failure). */
  protected retry(): void {
    this.alerts.retry();
  }

  private readonly farmNames = computed(
    () => new Map(this.fleet.farms().map((farm) => [farm.id, farm.name])),
  );

  private farmName(farmId: string): string | null {
    return this.farmNames().get(farmId) ?? null;
  }
}
