import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatChip, MatChipSet } from '@angular/material/chips';
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
import { NOW } from '../core/clock';
import { FleetStore } from '../fleet/fleet.store';
import { latestLoad } from '../ui/latest-load';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AlertHistoryApi } from './alert-history-api.service';
import { TurbineAlerts, groupAlertsByTurbine } from './alert-history';
import { dayOf, dayRange, defaultDays, pickerDate, rangeError } from '../core/utc-days';
import { AlertingTabs } from './alerting-tabs';
import { describeTriggerWithLevel } from './alert-text';
import { AlertLevelBadge } from './alert-level-badge';

/**
 * /alerting/history: the readings that triggered alert rules over whole UTC days chosen with a
 * Material date range picker (GET /api/alerts for [start 00:00, the day after end 00:00)), default
 * yesterday and today. A Material table with expandable rows: one summary row per turbine
 * (latest alert, a pill per level with its alert count) that
 * expands to its flagged readings, newest first, each with its rules as chips. 25 turbines per
 * page. Days are UTC like every time in the app; choosing a valid range reloads.
 */
@Component({
  selector: 'app-alert-history-page',
  imports: [
    AlertLevelBadge,
    AlertingTabs,
    DatePipe,
    MatButton,
    MatChip,
    MatChipSet,
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
  // The datepicker's DateAdapter: native Dates (local midnights, read as UTC days by utcDayOf).
  providers: [provideNativeDateAdapter()],
  // A column filling the shell's window-high page (route data `fillViewport`): heading, tabs and
  // range keep their height, the table frame takes what is left and scrolls its rows.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertHistoryPage {
  private readonly api = inject(AlertHistoryApi);
  private readonly fleet = inject(FleetStore);

  private readonly now = inject(NOW);
  /** The picked days (the picker's Dates; null while not chosen or not a valid date). */
  protected readonly start = signal<Date | null>(null);
  protected readonly end = signal<Date | null>(null);
  /** No future days to pick: the last selectable day is today (UTC). */
  protected readonly maxDate = pickerDate(defaultDays(this.now()).end);
  private readonly startDay = computed(() => dayOf(this.start()));
  private readonly endDay = computed(() => dayOf(this.end()));
  protected readonly error = computed(() => rangeError(this.startDay(), this.endDay()));

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
  protected readonly describe = describeTriggerWithLevel;

  constructor() {
    const { start, end } = defaultDays(this.now());
    this.start.set(pickerDate(start));
    this.end.set(pickerDate(end));
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

  /** The picker changed a day (calendar or typed); a complete, valid range reloads. */
  protected onStart(date: Date | null): void {
    this.start.set(date);
    this.load();
  }

  protected onEnd(date: Date | null): void {
    this.end.set(date);
    this.load();
  }

  /** Loads the chosen days (an incomplete or invalid range keeps the last results and says why). */
  protected load(): void {
    if (this.error()) return;
    this.alerts.run(dayRange(this.startDay()!, this.endDay()!));
  }

  private readonly farmNames = computed(
    () => new Map(this.fleet.farms().map((farm) => [farm.id, farm.name])),
  );

  private farmName(farmId: string): string | null {
    return this.farmNames().get(farmId) ?? null;
  }
}
