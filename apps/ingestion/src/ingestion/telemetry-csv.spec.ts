import { parseTelemetryCsv, TelemetryCsvError } from './telemetry-csv.js';

const HEADER =
  'turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c';
const ROW =
  'TURB001,FARM01,2026-03-01T00:00:00Z,2026-03-01T00:02:00Z,2331.2,8.0,14.0,3.6,81.6';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

/** Runs the parser and returns the TelemetryCsvError it throws. */
function failure(text: string): TelemetryCsvError {
  try {
    parseTelemetryCsv(text);
  } catch (error) {
    if (error instanceof TelemetryCsvError) return error;
    throw error;
  }
  throw new Error('expected parseTelemetryCsv to throw');
}

describe('parseTelemetryCsv', () => {
  it('parses rows into typed readings with their line numbers', () => {
    expect(parseTelemetryCsv(csv(ROW)).rows).toEqual([
      {
        line: 2,
        reading: expect.objectContaining({
          turbine_id: 'TURB001',
          farm_id: 'FARM01',
          timestamp: '2026-03-01T00:00:00Z',
          received_at: '2026-03-01T00:02:00Z',
          power_output_kw: 2331.2,
          gearbox_temp_c: 81.6,
        }),
      },
    ]);
  });

  it('treats an empty received_at as "use the upload time"', () => {
    const [row] = parseTelemetryCsv(
      csv('TURB001,FARM01,2026-03-01T00:00:00Z,,2331.2,8.0,14.0,3.6,81.6'),
    ).rows;
    expect(row.reading.received_at).toBeUndefined();
  });

  it('accepts anomalies (e.g. the 126.5 °C gearbox) like the Pub/Sub path does', () => {
    expect(
      parseTelemetryCsv(
        csv('TURB002,FARM02,2026-03-01T00:00:00Z,,2200,10.7,12.8,3.8,126.5'),
      ),
    ).toEqual({ rows: [expect.anything()], rowErrors: [] });
  });

  it('collects every invalid row by line (one message per field) and keeps the valid ones', () => {
    const { rows, rowErrors } = parseTelemetryCsv(
      csv(
        ROW,
        'TURB001,FARM01,not-a-date,,2331.2,8.0,14.0,3.6,81.6',
        'TURB001,FARM01,2026-03-01T00:10:00Z,,-5,,14.0,3.6,81.6',
      ),
    );

    expect(rows.map((r) => r.line)).toEqual([2]);
    expect(rowErrors).toEqual([
      { line: 3, errors: ['timestamp must be a valid ISO 8601 date string'] },
      {
        line: 4,
        errors: [
          'wind_speed_ms is required',
          'power_output_kw must not be less than 0',
        ],
      },
    ]);
  });

  it.each([
    ['an empty file', '', 'The CSV file is empty'],
    ['a header with no rows', HEADER, 'The CSV file has a header but no rows'],
    [
      'a different header',
      'turbine,time\nTURB001,2026',
      'Unexpected CSV header',
    ],
    ['a short row', csv('TURB001,FARM01'), 'CSV line 2'],
  ])('rejects %s', (_, text, message) => {
    expect(failure(text).message).toContain(message);
  });
});
