import { DecimalPipe } from '@angular/common';
import { AppTimePipe } from '../core/app-time.pipe';
import { Component, computed, inject, signal } from '@angular/core';
import { MatButton, MatIconButton } from '@angular/material/button';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Router, RouterLink } from '@angular/router';
import { MapPlaceholder } from '../map/map-placeholder';
import { MapView } from '../map/map-view';
import { anomalyLoad } from '../alerting/anomaly-load';
import { formatEnergy } from '../alerting/anomaly.model';
import { FarmPill } from '../ui/farm-pill';
import { paginate } from '../ui/paging';
import { StatTile } from '../ui/stat-tile';
import { TABLE_IMPORTS } from '../ui/table';
import { FARM_LEGEND, farmMarkers } from './fleet-markers';
import { FarmSummary, FleetStore } from './fleet.store';

/**
 * Landing page: fleet totals, a map of every farm and the farm table. Choosing a farm opens it.
 * The totals and each farm's row come from the server's summaries, rebuilt about once a minute
 * (the "as of" times say when). The table has a text filter (name, id) and client-side pages: the
 * list is at most 10,000 summaries. The map always shows every farm (clustered when there are many).
 */
@Component({
  selector: 'app-fleet-overview',
  imports: [
    AppTimePipe,
    DecimalPipe,
    FarmPill,
    MatButton,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatLabel,
    MatProgressSpinnerModule,
    MatSuffix,
    RouterLink,
    MapPlaceholder,
    MapView,
    StatTile,
    TABLE_IMPORTS,
  ],
  templateUrl: './fleet-overview.html',
})
export class FleetOverview {
  protected readonly store = inject(FleetStore);
  private readonly router = inject(Router);
  /** The last 7 days' anomalies, for the lost-output tile only: a failure shows "–" there. */
  private readonly anomalies = anomalyLoad();
  protected readonly lostOutput = computed(() => {
    const report = this.anomalies.value();
    if (typeof report?.estimatedLostKwh !== 'number') return '–';
    // Past 5,000 episodes only the newest are summed: the figure is a lower bound.
    return (report.truncated ? '≥ ' : '') + formatEnergy(report.estimatedLostKwh);
  });
  /** Spinner only while there is no answer yet (and no failure), so a reload never hides a value. */
  protected readonly lostOutputLoading = computed(
    () => this.anomalies.value() === null && !this.anomalies.failed(),
  );
  protected readonly lostOutputFailed = this.anomalies.failed;
  protected readonly markers = computed(() => farmMarkers(this.store.farms()));
  protected readonly columns = [
    'farm',
    'location',
    'turbines',
    'reporting',
    'power',
    'wind',
    'asOf',
  ];
  protected readonly trackById = (_: number, farm: FarmSummary) => farm.id;
  protected readonly legend = FARM_LEGEND;
  /** The farm filter's text (case-insensitive, on the farm's name or id). */
  protected readonly filter = signal('');
  protected readonly filtered = computed(() => {
    const text = this.filter().trim().toLowerCase();
    if (!text) return this.store.farms();
    return this.store
      .farms()
      .filter((f) => f.name.toLowerCase().includes(text) || f.id.toLowerCase().includes(text));
  });
  /** Client-side pages of the farm table: thousands of farms are too many rows at once. */
  protected readonly paging = paginate(this.filtered, 25);

  protected onFilter(event: Event): void {
    this.filter.set((event.target as HTMLInputElement).value);
    this.paging.reset();
  }

  protected clearFilter(input: HTMLInputElement): void {
    this.filter.set('');
    this.paging.reset();
    input.focus();
  }

  protected retryLostOutput(): void {
    this.anomalies.retry();
  }

  protected open(farmId: string): void {
    void this.router.navigate(['/farms', farmId]);
  }
}
