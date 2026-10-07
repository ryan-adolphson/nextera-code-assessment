import { AlertConfig, AlertLevel } from '../alerting/alert-config.model';
import { LEVEL_SEVERITY, describeTriggerWithLevel } from '../alerting/alert-text';
import { ChartMarker } from '../charts/line-chart';
import { ChartPoint } from '../charts/scales';
import { Telemetry } from '../fleet/fleet.model';
import { METRICS, Metric } from '../fleet/metrics';
import { TelemetryReport } from './report-api.service';

/** An autocomplete choice: a farm or a turbine. */
export interface ScopeOption {
  kind: 'farm' | 'turbine';
  /** The farm id ("FARM01") or the turbine id ("TURB001"). */
  id: string;
  /** What the field shows once chosen, e.g. "Prairie Ridge (FARM01)" or "TURB001 · Prairie Ridge". */
  label: string;
}

/** The autocomplete's groups, from the fleet the shell already loaded. */
export function scopeOptions(
  farms: readonly { id: string; name: string }[],
  turbines: readonly { id: string; farmName: string }[],
): { farms: ScopeOption[]; turbines: ScopeOption[] } {
  return {
    farms: farms.map((f) => ({ kind: 'farm', id: f.id, label: `${f.name} (${f.id})` })),
    turbines: turbines.map((t) => ({
      kind: 'turbine',
      id: t.id,
      label: `${t.id} · ${t.farmName}`,
    })),
  };
}

/** Options whose label contains the typed text (case-insensitive); all of them for none. */
export function filterOptions(options: readonly ScopeOption[], query: string): ScopeOption[] {
  const q = query.trim().toLowerCase();
  return q ? options.filter((o) => o.label.toLowerCase().includes(q)) : [...options];
}

/** The charts of a report: one series per metric, and the alerts line with its flagged points. */
export interface ReportSeries {
  metrics: Record<Metric, ChartPoint[]>;
  /** Alerts per time: rules triggered per reading (turbine) or summed over the farm (farm). */
  alerts: ChartPoint[];
  /** The times with alerts, coloured by the worst level; the tooltip lists them. */
  markers: ChartMarker[];
}

/**
 * Chart series for a report. A turbine report plots its readings. A farm report aggregates its
 * turbines per measurement time: power summed (the farm's output), the other metrics averaged;
 * alerts summed, with each line naming its turbine.
 */
export function reportSeries(report: TelemetryReport): ReportSeries {
  const farm = report.scope.kind === 'farm';
  const byTime = new Map<number, Telemetry[]>();
  for (const r of report.readings) {
    const t = Date.parse(r.timestamp);
    byTime.set(t, [...(byTime.get(t) ?? []), r]);
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const metrics = Object.fromEntries(
    METRICS.map(({ key }) => [
      key,
      times.map((t): ChartPoint => {
        const values = byTime.get(t)!.map((r) => r[key]);
        const sum = values.reduce((a, b) => a + b, 0);
        return { t, v: key === 'powerOutputKw' ? sum : sum / values.length };
      }),
    ]),
  ) as Record<Metric, ChartPoint[]>;

  const alerts = times.map((t): ChartPoint => ({
    t,
    v: byTime.get(t)!.reduce((n, r) => n + r.alerts.length, 0),
  }));
  const markers = times.flatMap((t): ChartMarker[] => {
    const flagged = byTime.get(t)!.filter((r) => r.alerts.length);
    if (!flagged.length) return [];
    const rules = flagged.flatMap((r) => r.alerts);
    return [
      {
        t,
        v: rules.length,
        level: worstLevel(rules),
        lines: flagged.flatMap((r) =>
          r.alerts.map(
            (rule) => `${farm ? `${r.turbineId}: ` : ''}${describeTriggerWithLevel(r, rule)}`,
          ),
        ),
      },
    ];
  });
  return { metrics, alerts, markers };
}

function worstLevel(rules: readonly AlertConfig[]): AlertLevel {
  return rules.reduce<AlertLevel>(
    (worst, rule) =>
      LEVEL_SEVERITY[rule.alertLevel] > LEVEL_SEVERITY[worst] ? rule.alertLevel : worst,
    'info',
  );
}

/** The telemetry.csv column of each metric (the CSV and the alerts column use them). */
const COLUMN: Record<Metric, string> = {
  powerOutputKw: 'power_output_kw',
  windSpeedMs: 'wind_speed_ms',
  rotorRpm: 'rotor_rpm',
  bladePitchDeg: 'blade_pitch_deg',
  gearboxTempC: 'gearbox_temp_c',
};

export const CSV_HEADER = [
  'turbine_id',
  'farm_id',
  'timestamp',
  'received_at',
  ...METRICS.map((m) => COLUMN[m.key]),
  'alerts',
];

/**
 * The report as CSV: telemetry.csv's columns plus `alerts` (the rules each reading triggered, e.g.
 * "error:gearbox_temp_c above 120; warn:gearbox_temp_c above 90"). RFC 4180: comma-separated,
 * CRLF line ends, fields with a comma, quote or line break are quoted (quotes doubled).
 */
export function toCsv(report: TelemetryReport): string {
  const rows = report.readings.map((r) => [
    r.turbineId,
    r.farmId,
    r.timestamp,
    r.receivedAt,
    ...METRICS.map((m) => String(r[m.key])),
    r.alerts
      .map((a) => `${a.alertLevel}:${COLUMN[a.measurementMetric]} ${a.comparison} ${a.valueMetric}`)
      .join('; '),
  ]);
  return [CSV_HEADER, ...rows].map((row) => row.map(csvField).join(',')).join('\r\n') + '\r\n';
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** "report-TURB002-2026-01-01-2026-01-02.csv": the scope and the chosen days (to is exclusive). */
export function csvFileName(report: TelemetryReport): string {
  const day = (iso: string) => iso.slice(0, 10);
  const lastDay = new Date(Date.parse(report.to) - 24 * 60 * 60_000).toISOString();
  return `report-${report.scope.id}-${day(report.from)}-${day(lastDay)}.csv`;
}

/** Saves `csv` as a file through a temporary download link (no server round trip). */
export function downloadCsv(fileName: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
