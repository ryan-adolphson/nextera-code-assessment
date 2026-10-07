import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatChip, MatChipSet } from '@angular/material/chips';
import { MatFormField, MatLabel } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { NOW } from '../core/clock';
import { Telemetry } from '../fleet/fleet.model';
import { FleetStore } from '../fleet/fleet.store';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AlertHistoryApi } from './alert-history-api.service';
import {
  HistoryRow,
  fromUtcInput,
  groupByTurbine,
  last24Hours,
  rangeError,
  toUtcInput,
} from './alert-history';
import { AlertingTabs } from './alerting-tabs';
import { describeTriggerWithLevel } from './evaluate-alerts';

/**
 * /alerting/history: the readings that triggered alert rules in a time range (GET /api/alerts),
 * default the last 24 hours. A Material table grouped by turbine (a header row per turbine, then
 * its flagged readings, newest first) with each triggered rule as a Material chip; 25 readings per
 * page. The range is in UTC like every time in the app; changing it reloads.
 */
@Component({
  selector: 'app-alert-history-page',
  imports: [
    AlertingTabs,
    DatePipe,
    MatChip,
    MatChipSet,
    MatFormField,
    MatInput,
    MatLabel,
    RouterLink,
    TABLE_IMPORTS,
  ],
  templateUrl: './alert-history-page.html',
  // A column filling the shell's window-high page (route data `fillViewport`): heading, tabs and
  // range keep their height, the table frame takes what is left and scrolls its rows.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertHistoryPage {
  private readonly api = inject(AlertHistoryApi);
  private readonly fleet = inject(FleetStore);
  private readonly destroyRef = inject(DestroyRef);

  /** The range inputs (`datetime-local`, UTC). */
  protected readonly fromInput = signal('');
  protected readonly toInput = signal('');
  protected readonly error = computed(() =>
    rangeError(fromUtcInput(this.fromInput()), fromUtcInput(this.toInput())),
  );

  protected readonly readings = signal<Telemetry[]>([]);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  protected readonly turbineCount = computed(
    () => new Set(this.readings().map((r) => r.turbineId)).size,
  );

  /** 25 readings per page; group headers are added per page (repeated when a turbine continues). */
  protected readonly paging = paginate(this.readings, 25);
  protected readonly rows = computed(() =>
    groupByTurbine(this.paging.page(), this.readings(), (farmId) => this.farmName(farmId)),
  );
  protected readonly columns = ['measured', 'alerts'];
  protected readonly isGroup = (_: number, row: HistoryRow) => row.kind === 'group';
  protected readonly trackRow = (_: number, row: HistoryRow) =>
    row.kind === 'group' ? `group:${row.turbineId}` : row.reading.id;
  protected readonly describe = describeTriggerWithLevel;

  private request?: Subscription;

  constructor() {
    const { from, to } = last24Hours(inject(NOW)());
    this.fromInput.set(toUtcInput(from));
    this.toInput.set(toUtcInput(to));
    this.load();
  }

  protected onFrom(event: Event): void {
    this.fromInput.set((event.target as HTMLInputElement).value);
    this.load();
  }

  protected onTo(event: Event): void {
    this.toInput.set((event.target as HTMLInputElement).value);
    this.load();
  }

  /** Loads the current range (an invalid range keeps the last results and shows why). */
  protected load(): void {
    if (this.error()) return;
    const from = new Date(fromUtcInput(this.fromInput())!).toISOString();
    const to = new Date(fromUtcInput(this.toInput())!).toISOString();
    this.request?.unsubscribe(); // only the latest range's answer counts
    this.loading.set(true);
    this.failed.set(false);
    this.request = this.api
      .list(from, to)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (readings) => {
          this.readings.set(readings);
          this.paging.reset();
          this.loading.set(false);
        },
        error: () => {
          this.failed.set(true);
          this.loading.set(false);
        },
      });
  }

  private readonly farmNames = computed(
    () => new Map(this.fleet.farms().map((farm) => [farm.id, farm.name])),
  );

  private farmName(farmId: string): string | null {
    return this.farmNames().get(farmId) ?? null;
  }
}
