import { Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { AppTimePipe } from '../core/app-time.pipe';
import { TimeZoneSettings } from '../core/time-zone';
import { FleetStore } from '../fleet/fleet.store';
import { FarmPill } from '../ui/farm-pill';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AlertingTabs } from './alerting-tabs';
import { DecimalPipe } from '@angular/common';
import { anomalyLoad } from './anomaly-load';
import { Anomaly, KIND_LABELS, anomalyDuration, formatEnergy, stuckText } from './anomaly.model';

/** /alerting/anomalies: low power in strong wind and stuck sensors of the last 7 days. */
@Component({
  selector: 'app-anomalies-page',
  imports: [AlertingTabs, AppTimePipe, DecimalPipe, FarmPill, MatButton, RouterLink, TABLE_IMPORTS],
  templateUrl: './anomalies-page.html',
})
export class AnomaliesPage {
  private readonly fleet = inject(FleetStore);
  protected readonly tz = inject(TimeZoneSettings);
  private readonly load = anomalyLoad();

  protected readonly report = this.load.value;
  protected readonly loading = this.load.loading;
  protected readonly failed = this.load.failed;
  protected readonly paging = paginate(
    computed(() => this.report()?.anomalies ?? []),
    25,
  );
  protected readonly columns = ['turbine', 'farm', 'kind', 'detail', 'start', 'duration', 'lost'];
  private readonly farmNames = computed(
    () => new Map(this.fleet.farms().map((farm) => [farm.id, farm.name])),
  );

  protected readonly kindLabel = (a: Anomaly) => KIND_LABELS[a.kind];
  protected readonly duration = anomalyDuration;
  protected readonly stuck = stuckText;
  protected readonly energy = formatEnergy;
  protected readonly lost = (a: Anomaly) =>
    a.estimatedLostKwh === null ? '–' : formatEnergy(a.estimatedLostKwh);
  protected farmName(farmId: string): string {
    return this.farmNames().get(farmId) ?? farmId;
  }
  protected readonly trackAnomaly = (_: number, a: Anomaly) =>
    `${a.turbineId}|${a.kind}|${a.start}`;

  protected retry(): void {
    this.load.retry();
  }
}
