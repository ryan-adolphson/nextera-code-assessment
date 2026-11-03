import { METRICS, Metric } from '../fleet/metrics';

export type AnomalyKind = 'low_power_in_wind' | 'stuck_sensor';

/** One detected episode (GET /api/anomalies): a run of readings on one turbine. */
export interface Anomaly {
  turbineId: string;
  farmId: string;
  kind: AnomalyKind;
  /** The stuck sensor's metric (stuck_sensor only). */
  metric: 'gearboxTempC' | 'windSpeedMs' | 'rotorRpm' | null;
  start: string;
  end: string;
  readings: number;
  /** The stuck value (stuck_sensor). */
  value: number | null;
  /** Mean wind over the episode (low_power_in_wind). */
  windSpeedMs: number | null;
  estimatedLostKwh: number | null;
}

/** The response, newest end first. */
export interface AnomalyReport {
  from: string;
  to: string;
  estimatedLostKwh: number;
  anomalies: Anomaly[];
}

/** The fixed window of the Anomalies tab and the fleet tile. */
export const ANOMALY_DAYS = 7;
/** Telemetry interval: an episode lasts from its first reading to its last one plus one interval. */
export const READING_INTERVAL_MS = 5 * 60_000;

export const KIND_LABELS: Record<AnomalyKind, string> = {
  low_power_in_wind: 'Low power in strong wind',
  stuck_sensor: 'Stuck sensor',
};

/** The last 7 days ending at `now` (ISO instants; independent of the time-zone setting). */
export function anomalyWindow(now: number): { from: string; to: string } {
  return {
    from: new Date(now - ANOMALY_DAYS * 86_400_000).toISOString(),
    to: new Date(now).toISOString(),
  };
}

/** "15 min", "1 h 5 min", "2 h", "1 d 3 h": start to end plus one reading interval. */
export function anomalyDuration(a: Pick<Anomaly, 'start' | 'end'>): string {
  const minutes = Math.round(
    (Date.parse(a.end) - Date.parse(a.start) + READING_INTERVAL_MS) / 60_000,
  );
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60];
  return [d && `${d} d`, h && `${h} h`, (m || (!d && !h)) && `${m} min`].filter(Boolean).join(' ');
}

/** What the sensor was stuck at, e.g. "Gearbox temperature stuck at 126.5 °C". */
export function stuckText(a: Pick<Anomaly, 'metric' | 'value'>): string {
  const meta = METRICS.find((m) => m.key === (a.metric as Metric | null));
  if (!meta || a.value === null) return 'Sensor stuck';
  return `${meta.title} stuck at ${a.value.toFixed(meta.decimals)} ${meta.unit}`;
}

/** Lost output as "850 kWh" or "1.3 MWh" (kWh under 1,000). */
export function formatEnergy(kwh: number): string {
  return Math.abs(kwh) < 1000
    ? `${Math.round(kwh).toLocaleString('en-US')} kWh`
    : `${(kwh / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MWh`;
}
