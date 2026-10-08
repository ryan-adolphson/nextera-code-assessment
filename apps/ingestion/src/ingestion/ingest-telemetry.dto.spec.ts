import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IngestTelemetryDto } from './ingest-telemetry.dto.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const SKEW_MS = 5 * 60_000;

const reading = {
  turbine_id: 'TURB001',
  farm_id: 'FARM01',
  timestamp: '2026-01-01T00:00:00Z',
  received_at: '2026-01-01T00:02:00Z',
  power_output_kw: 2331.2,
  wind_speed_ms: 8.0,
  rotor_rpm: 14.0,
  blade_pitch_deg: 3.6,
  gearbox_temp_c: 81.6,
};

/** The validation messages for one payload, by property. */
function errorsOf(payload: Record<string, unknown>): Record<string, string[]> {
  return Object.fromEntries(
    validateSync(plainToInstance(IngestTelemetryDto, payload)).map((e) => [
      e.property,
      Object.values(e.constraints ?? {}),
    ]),
  );
}

const FORMAT = (field: string) =>
  `${field} must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)`;

describe('IngestTelemetryDto timestamps', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['Z', '2026-01-01T00:00:00Z'],
    ['an offset', '2026-01-01T02:00:00+02:00'],
    ['a negative offset', '2025-12-31T19:00:00-05:00'],
    ['milliseconds', '2026-01-01T00:00:00.123Z'],
    ['microseconds', '2026-01-01T00:00:00.123456Z'],
    ['no seconds', '2026-01-01T00:00Z'],
    ['a leap day', '2024-02-29T00:00:00Z'],
    ['2000-01-01T00:00Z exactly', '2000-01-01T00:00:00Z'],
  ])('accepts a timestamp with %s', (_, timestamp) => {
    expect(errorsOf({ ...reading, timestamp, received_at: timestamp })).toEqual(
      {},
    );
  });

  it('accepts an omitted received_at', () => {
    const { received_at: _, ...live } = reading;
    expect(errorsOf(live)).toEqual({});
  });

  it.each([
    ['a week date', '2026-W02-3'],
    ['an ordinal date', '2026-008'],
    ['a date only', '2026-01-01'],
    ['no time zone', '2026-01-01T00:00:00'],
    ['a space instead of T', '2026-01-01 00:00:00Z'],
    ['a basic-format date-time', '20260101T000000Z'],
    ['an hour-only offset', '2026-01-01T00:00:00+02'],
    ['free text', 'soon'],
    ['an empty string', ''],
  ])('rejects %s with a format message', (_, value) => {
    expect(
      errorsOf({ ...reading, timestamp: value, received_at: value }),
    ).toEqual({
      timestamp: [FORMAT('timestamp')],
      received_at: [FORMAT('received_at')],
    });
  });

  it('rejects a non-string timestamp', () => {
    expect(errorsOf({ ...reading, timestamp: 1767225600000 })).toEqual({
      timestamp: [FORMAT('timestamp')],
    });
  });

  it.each([
    ['30 February', '2026-02-30T00:00:00Z'],
    ['29 February in a common year', '2026-02-29T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
    ['minute 60', '2026-01-01T00:60:00Z'],
    ['second 60', '2026-01-01T00:00:60Z'],
    ['an offset of 24 hours', '2026-01-01T00:00:00+24:00'],
  ])('rejects %s (no calendar rollover)', (_, timestamp) => {
    expect(errorsOf({ ...reading, timestamp })).toEqual({
      timestamp: ['timestamp must be a real calendar date and time'],
    });
  });

  it('accepts a timestamp up to the clock-skew allowance in the future', () => {
    const edge = new Date(NOW.getTime() + SKEW_MS).toISOString();
    expect(
      errorsOf({ ...reading, timestamp: edge, received_at: edge }),
    ).toEqual({});
  });

  it('rejects a timestamp 1 ms past the clock-skew allowance', () => {
    const late = new Date(NOW.getTime() + SKEW_MS + 1).toISOString();
    expect(
      errorsOf({ ...reading, timestamp: late, received_at: late }),
    ).toEqual({
      timestamp: ['timestamp must not be more than 5 minutes in the future'],
      received_at: [
        'received_at must not be more than 5 minutes in the future',
      ],
    });
  });

  it('applies the future bound after the offset (an instant, not wall time)', () => {
    // 13:00 wall time at +02:00 is 11:00Z, an hour before NOW.
    expect(
      errorsOf({ ...reading, timestamp: '2026-10-08T13:00:00+02:00' }),
    ).toEqual({});
  });

  it('rejects a far-future timestamp that would stay the "latest" reading forever', () => {
    expect(errorsOf({ ...reading, timestamp: '2099-01-01T00:00:00Z' })).toEqual(
      {
        timestamp: ['timestamp must not be more than 5 minutes in the future'],
      },
    );
  });

  it('rejects a timestamp before 2000-01-01T00:00Z', () => {
    expect(
      errorsOf({ ...reading, timestamp: '1999-12-31T23:59:59.999Z' }),
    ).toEqual({
      timestamp: ['timestamp must not be before 2000-01-01T00:00:00Z'],
    });
  });
});
