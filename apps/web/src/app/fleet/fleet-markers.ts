import { LegendItem, MapMarker } from '../map/map-view';
import { FarmSummary } from './fleet.store';
import { TurbineMarkerResponse } from './fleet.model';
import { STALENESS_LABELS, STALENESS_LEVELS, Staleness, stalenessOf } from './staleness';

const kw = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Reporting, then the three "No data in …" levels (yellow, orange, red). */
const REPORTING_LEVELS: LegendItem[] = [
  { status: 'ok', label: STALENESS_LABELS.ok },
  ...STALENESS_LEVELS.map(({ level, label }) => ({ status: level, label })),
];

export const FARM_LEGEND: LegendItem[] = [
  ...REPORTING_LEVELS,
  { status: 'empty', label: 'No turbines or readings' },
];

export const TURBINE_LEGEND: LegendItem[] = [
  ...REPORTING_LEVELS,
  { status: 'empty', label: STALENESS_LABELS.empty },
];

/** The level's label as an extra tooltip line, only when the marker is flagged. */
const flagged = (staleness: Staleness): string[] =>
  staleness === 'ok' || staleness === 'empty' ? [] : [STALENESS_LABELS[staleness]];

/**
 * One marker per farm, sized by turbine count and coloured by the farm's staleness (see
 * `FleetStore.farms`). UI seam: with thousands of farms this wants marker clustering.
 */
export function farmMarkers(farms: FarmSummary[]): MapMarker[] {
  return farms.map((farm) => ({
    id: farm.id,
    lat: farm.latitude,
    lng: farm.longitude,
    status: farm.turbineCount === 0 ? 'empty' : farm.staleness,
    radius: Math.min(7 + farm.turbineCount * 2, 18),
    tooltip:
      farm.turbineCount === 0
        ? [farm.name, 'No turbines registered']
        : [
            farm.name,
            `${farm.reporting} / ${farm.turbineCount} turbines reporting · ${kw.format(farm.powerKw)} kW`,
            ...flagged(farm.staleness),
          ],
  }));
}

/**
 * The level a marker shows. The pill and map keep the four client-clock levels where the marker
 * has a time (the markers route gives the server's three states and the latest time); a turbine
 * the server calls stale never shows as reporting.
 */
export function markerStaleness(marker: TurbineMarkerResponse, now: number): Staleness {
  if (marker.status === 'no_data' || !marker.timestamp) return 'empty';
  const level = stalenessOf({ timestamp: marker.timestamp }, now);
  return marker.status === 'stale' && level === 'ok' ? 'stale-15' : level;
}

/** One marker per turbine at its own coordinates (from GET /api/farms/:farmId/turbine-markers). */
export function turbineMarkers(markers: TurbineMarkerResponse[], now: number): MapMarker[] {
  return markers.map((t) => {
    const staleness = markerStaleness(t, now);
    return {
      id: t.id,
      lat: t.latitude,
      lng: t.longitude,
      status: staleness,
      radius: 9,
      tooltip: [t.id, staleness === 'empty' ? STALENESS_LABELS.empty : STALENESS_LABELS[staleness]],
    };
  });
}
