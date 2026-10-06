import { LegendItem, MapMarker } from '../map/map-view';
import { FarmSummary } from './fleet.store';
import { Telemetry, TurbineOverview } from './fleet.model';
import { STALENESS_LABELS, STALENESS_LEVELS, Staleness } from './staleness';

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
 * One marker per farm, sized by turbine count and coloured by the farm's staleness: its freshest
 * turbine (see `FleetStore.farms`).
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

type TurbineWithState = TurbineOverview & { latest: Telemetry | null; staleness: Staleness };

/** One marker per turbine at its own coordinates. */
export function turbineMarkers(turbines: TurbineWithState[]): MapMarker[] {
  return turbines.map((t) => ({
    id: t.id,
    lat: t.latitude,
    lng: t.longitude,
    status: t.latest ? t.staleness : 'empty',
    radius: 9,
    tooltip: t.latest
      ? [
          t.id,
          `${kw.format(t.latest.powerOutputKw)} kW · wind ${t.latest.windSpeedMs.toFixed(1)} m/s`,
          ...flagged(t.staleness),
        ]
      : [t.id, STALENESS_LABELS.empty],
  }));
}
