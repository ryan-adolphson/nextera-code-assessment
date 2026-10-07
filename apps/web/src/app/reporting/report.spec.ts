import { AlertConfig } from '../alerting/alert-config.model';
import { reading } from '../fleet/testing';
import { TelemetryReport } from './report-api.service';
import {
  CSV_HEADER,
  csvFileName,
  downloadCsv,
  filterOptions,
  reportSeries,
  scopeOptions,
  toCsv,
} from './report';

const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: 'gearbox-error',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});
const warn = rule({ id: 'gearbox-warn', valueMetric: 90, alertLevel: 'warn' });

const report = (
  kind: 'farm' | 'turbine',
  readings: TelemetryReport['readings'],
): TelemetryReport => ({
  scope: {
    kind,
    id: kind === 'farm' ? 'FARM02' : 'TURB002',
    name: 'High Plains',
    farmId: 'FARM02',
  },
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-03T00:00:00.000Z',
  readings,
});

describe('scope options', () => {
  const options = scopeOptions(
    [
      { id: 'FARM01', name: 'Prairie Ridge' },
      { id: 'FARM02', name: 'High Plains' },
    ],
    [{ id: 'TURB002', farmName: 'High Plains' }],
  );

  it('lists farms and turbines with readable labels', () => {
    expect(options).toEqual({
      farms: [
        { kind: 'farm', id: 'FARM01', label: 'Prairie Ridge (FARM01)' },
        { kind: 'farm', id: 'FARM02', label: 'High Plains (FARM02)' },
      ],
      turbines: [{ kind: 'turbine', id: 'TURB002', label: 'TURB002 · High Plains' }],
    });
  });

  it('filters by what was typed, case-insensitively, on name and id', () => {
    expect(filterOptions(options.farms, 'high').map((o) => o.id)).toEqual(['FARM02']);
    expect(filterOptions(options.farms, 'farm01').map((o) => o.id)).toEqual(['FARM01']);
    expect(filterOptions(options.farms, '  ')).toHaveLength(2);
  });
});

describe('reportSeries', () => {
  const at = (hhmm: string) => `2026-01-02T${hhmm}:00.000Z`;

  it('plots a turbine report reading by reading, with alerts per reading as markers', () => {
    const series = reportSeries(
      report('turbine', [
        reading({ id: 'a', timestamp: at('03:15'), gearboxTempC: 80 }),
        reading({ id: 'b', timestamp: at('03:20'), gearboxTempC: 126.5, alerts: [rule(), warn] }),
      ]),
    );
    expect(series.metrics.gearboxTempC).toEqual([
      { t: Date.parse(at('03:15')), v: 80 },
      { t: Date.parse(at('03:20')), v: 126.5 },
    ]);
    expect(series.alerts.map((p) => p.v)).toEqual([0, 2]);
    expect(series.markers).toEqual([
      {
        t: Date.parse(at('03:20')),
        v: 2,
        level: 'error',
        lines: [
          'Error: Gearbox temperature 126.5 °C > 120',
          'Warning: Gearbox temperature 126.5 °C > 90',
        ],
      },
    ]);
  });

  it('aggregates a farm per time: power summed, other metrics averaged, alerts summed by turbine', () => {
    const series = reportSeries(
      report('farm', [
        reading({
          turbineId: 'TURB002',
          timestamp: at('03:20'),
          powerOutputKw: 2000,
          windSpeedMs: 8,
          gearboxTempC: 126.5,
          alerts: [warn],
        }),
        reading({
          turbineId: 'TURB009',
          timestamp: at('03:20'),
          powerOutputKw: 1500,
          windSpeedMs: 10,
          gearboxTempC: 80,
        }),
      ]),
    );
    const t = Date.parse(at('03:20'));
    expect(series.metrics.powerOutputKw).toEqual([{ t, v: 3500 }]);
    expect(series.metrics.windSpeedMs).toEqual([{ t, v: 9 }]);
    expect(series.metrics.gearboxTempC).toEqual([{ t, v: 103.25 }]);
    expect(series.markers).toEqual([
      { t, v: 1, level: 'warn', lines: ['TURB002: Warning: Gearbox temperature 126.5 °C > 90'] },
    ]);
  });
});

describe('CSV', () => {
  it('writes telemetry.csv columns plus the alerts each reading triggered (RFC 4180)', () => {
    const csv = toCsv(
      report('turbine', [
        reading({
          turbineId: 'TURB002',
          farmId: 'FARM02',
          timestamp: '2026-01-02T03:20:00.000Z',
          receivedAt: '2026-01-02T03:21:00.000Z',
          powerOutputKw: 2200,
          windSpeedMs: 8.5,
          rotorRpm: 13,
          bladePitchDeg: 4,
          gearboxTempC: 126.5,
          alerts: [rule(), warn],
        }),
        reading({ turbineId: 'TURB002', farmId: 'FARM02', timestamp: '2026-01-02T03:25:00.000Z' }),
      ]),
    );
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c,alerts',
    );
    expect(lines[0].split(',')).toEqual(CSV_HEADER);
    expect(lines[1]).toBe(
      'TURB002,FARM02,2026-01-02T03:20:00.000Z,2026-01-02T03:21:00.000Z,2200,8.5,13,4,126.5,error:gearbox_temp_c above 120; warn:gearbox_temp_c above 90',
    );
    expect(lines[2].endsWith(',')).toBe(true); // no alerts: an empty last field
    expect(lines.at(-1)).toBe(''); // ends with CRLF
  });

  it('quotes fields with commas, quotes or line breaks', () => {
    const csv = toCsv(report('turbine', [reading({ turbineId: 'TURB,"9"' })]));
    expect(csv.split('\r\n')[1].startsWith('"TURB,""9"""')).toBe(true);
  });

  it('names the file after the scope and the chosen days (to is exclusive)', () => {
    expect(csvFileName(report('turbine', []))).toBe('report-TURB002-2026-01-01-2026-01-02.csv');
  });

  it('downloads through a temporary object URL and link', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:report');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);

    downloadCsv('report.csv', 'a,b\r\n');

    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('text/csv;charset=utf-8');
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect([link.href, link.download]).toEqual(['blob:report', 'report.csv']);
    expect(revoke).toHaveBeenCalledWith('blob:report');
    vi.restoreAllMocks();
  });
});
