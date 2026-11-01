import { DecimalPipe } from '@angular/common';
import { AppTimePipe } from '../core/app-time.pipe';
import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MapPlaceholder } from '../map/map-placeholder';
import { MapView } from '../map/map-view';
import { StatTile } from '../ui/stat-tile';
import { TABLE_IMPORTS } from '../ui/table';
import { FARM_LEGEND, farmMarkers } from './fleet-markers';
import { FarmSummary, FleetStore } from './fleet.store';

/** Landing page: fleet totals, a map of every farm and the farm table. Choosing a farm opens it. */
@Component({
  selector: 'app-fleet-overview',
  imports: [AppTimePipe, DecimalPipe, RouterLink, MapPlaceholder, MapView, StatTile, TABLE_IMPORTS],
  templateUrl: './fleet-overview.html',
})
export class FleetOverview {
  protected readonly store = inject(FleetStore);
  private readonly router = inject(Router);
  protected readonly markers = computed(() => farmMarkers(this.store.farms()));
  protected readonly columns = ['farm', 'location', 'turbines', 'reporting', 'power', 'wind'];
  protected readonly trackById = (_: number, farm: FarmSummary) => farm.id;
  protected readonly legend = FARM_LEGEND;

  protected open(farmId: string): void {
    void this.router.navigate(['/farms', farmId]);
  }
}
