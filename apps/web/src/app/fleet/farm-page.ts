import { DecimalPipe } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MapMarker, MapView } from '../map/map-view';
import { StatTile } from '../ui/stat-tile';
import { TURBINE_LEGEND, turbineMarkers } from './fleet-markers';
import { FleetStore } from './fleet.store';
import { TurbineSortKey, TurbineTable } from './turbine-table';

/**
 * /farms/:farmId: one farm's totals, a map of its turbines and the shared turbines table (as on
 * /turbines, scoped to this farm, without the Farm column); a marker or a turbine id opens the
 * turbine page.
 */
@Component({
  selector: 'app-farm-page',
  imports: [DecimalPipe, RouterLink, MapView, StatTile, TurbineTable],
  templateUrl: './farm-page.html',
})
export class FarmPage {
  /** Bound from the route parameter (withComponentInputBinding). */
  readonly farmId = input.required<string>();

  protected readonly store = inject(FleetStore);
  private readonly router = inject(Router);
  protected readonly farm = computed(
    () => this.store.farms().find((f) => f.id === this.farmId()) ?? null,
  );
  protected readonly turbines = computed(() =>
    this.store.turbines().filter((t) => t.farmId === this.farmId()),
  );
  protected readonly legend = TURBINE_LEGEND;
  /** Every turbine here is on this farm. */
  protected readonly hiddenColumns: readonly TurbineSortKey[] = ['farm'];
  /** Turbines at their coordinates; a farm without turbines shows its own location instead. */
  protected readonly markers = computed<MapMarker[]>(() => {
    const farm = this.farm();
    if (!farm) return [];
    if (this.turbines().length) return turbineMarkers(this.turbines());
    return [
      {
        id: farm.id,
        lat: farm.latitude,
        lng: farm.longitude,
        status: 'empty',
        tooltip: [farm.name, 'No turbines registered'],
      },
    ];
  });

  /** Opens the clicked turbine (ignores the farm-location marker of an empty farm). */
  protected onMarkerClick(id: string): void {
    if (this.turbines().some((t) => t.id === id)) {
      void this.router.navigate(['/farms', this.farmId(), 'turbines', id]);
    }
  }
}
