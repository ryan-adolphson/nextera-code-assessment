import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AppTimePipe } from '../core/app-time.pipe';
import { MapPlaceholder } from '../map/map-placeholder';
// Separate declarations: MapView is @defer-red, and the compiler only defers a dependency whose
// whole import declaration it can drop.
import { MapView } from '../map/map-view';
import type { MapMarker } from '../map/map-view';
import { StatTile } from '../ui/stat-tile';
import { FarmWeather } from '../weather/farm-weather';
import { FarmHeader } from './farm-header';
import { TURBINE_LEGEND, turbineMarkers } from './fleet-markers';
import { FleetApi } from './fleet-api.service';
import { FleetStore } from './fleet.store';
import { TurbineColumn, TurbineTable } from './turbine-table';
import { latestLoad } from '../ui/latest-load';

/**
 * /farms/:farmId (the farm's Overview tab; Weather history is /farms/:farmId/weather): one farm's totals, its Open-Meteo weather (`FarmWeather`), a map of its turbines
 * and the shared turbines table (as on /turbines, scoped to this farm, without the Farm column); a
 * marker or a turbine id opens the turbine page.
 */
@Component({
  selector: 'app-farm-page',
  imports: [
    AppTimePipe,
    DecimalPipe,
    FarmHeader,
    RouterLink,
    FarmWeather,
    MapPlaceholder,
    MapView,
    StatTile,
    TurbineTable,
  ],
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
  private readonly api = inject(FleetApi);
  /** The farm's turbines as markers (id, position, status; no readings), reloaded with the summaries. */
  private readonly markerLoad = latestLoad((farmId: string) =>
    this.api.turbineMarkers(farmId).pipe(map((markers) => ({ farmId, markers }))),
  );
  /**
   * Only the markers loaded for this farm: after a route change to another farm the previous
   * farm's markers are still the last answer until the new one arrives, and must not show.
   */
  protected readonly turbines = computed(() => {
    const loaded = this.markerLoad.value();
    return loaded?.farmId === this.farmId() ? loaded.markers : [];
  });
  /** Whether the farm has turbines (from its summary, so it is right before the markers arrive). */
  protected readonly hasTurbines = computed(() => (this.farm()?.turbineCount ?? 0) > 0);
  protected readonly legend = TURBINE_LEGEND;
  /** Every turbine here is on this farm. */
  protected readonly hiddenColumns: readonly TurbineColumn[] = ['farm'];
  /** Turbines at their coordinates; a farm without turbines shows its own location instead. */
  protected readonly markers = computed<MapMarker[]>(() => {
    const farm = this.farm();
    if (!farm) return [];
    if (this.hasTurbines()) return turbineMarkers(this.turbines(), this.store.now());
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

  constructor() {
    // The farm's markers: for this farm, again each time the summaries refresh (about a minute).
    effect(() => {
      const farmId = this.farmId();
      this.store.summaryVersion();
      untracked(() => this.markerLoad.run(farmId));
    });
  }

  /** Opens the clicked turbine (ignores the farm-location marker of an empty farm). */
  protected onMarkerClick(id: string): void {
    if (this.turbines().some((t) => t.id === id)) {
      void this.router.navigate(['/farms', this.farmId(), 'turbines', id]);
    }
  }
}
