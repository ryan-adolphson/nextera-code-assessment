import {
  BadRequestException,
  ValidationPipe,
  type ArgumentMetadata,
} from '@nestjs/common';
import { AlertsQueryDto } from '../alerts/dto/alerts-query.dto.js';
import { TelemetryQueryDto } from '../fleet/dto/telemetry-query.dto.js';
import { ReportQueryDto } from '../reports/dto/report-query.dto.js';

// The from/to query bounds of every endpoint that takes them, through the app's global pipe.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const NOW = new Date('2026-10-08T12:00:00Z');
const FROM = '2026-01-01T00:00:00Z';
const TO = '2026-01-02T00:00:00Z';

const ENDPOINTS = [
  ['GET /api/alerts', AlertsQueryDto, {}],
  ['GET /api/turbines/:id/telemetry(/stats)', TelemetryQueryDto, {}],
  ['GET /api/reports/telemetry', ReportQueryDto, { turbineId: 'TURB001' }],
] as const;

/** The 400 messages for a query, or [] if it passes. */
async function messagesFor(
  dto: ArgumentMetadata['metatype'],
  query: Record<string, string>,
): Promise<string[]> {
  try {
    await pipe.transform(query, { type: 'query', metatype: dto });
    return [];
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const body = (error as BadRequestException).getResponse() as {
      message: string[];
    };
    return body.message;
  }
}

const FORMAT = (field: string) =>
  `${field} must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)`;
const CALENDAR = (field: string) =>
  `${field} must be a real calendar date and time`;

describe.each(ENDPOINTS)('%s from/to', (_, dto, base) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['Z', FROM, TO],
    ['offsets', '2026-01-01T02:00:00+02:00', '2026-01-01T19:00:00-05:00'],
    ['milliseconds', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.123Z'],
    // The web app's whole UTC days end at tomorrow 00:00Z; years ahead is fine for a bound.
    ['a future to', '2026-10-08T00:00:00.000Z', '2026-10-09T00:00:00.000Z'],
    ['a far-future to', FROM, '2099-01-01T00:00:00Z'],
    ['a from before 2000', '1999-12-31T23:00:00Z', '2000-01-01T00:00:00Z'],
  ])('accepts %s', async (_, from, to) => {
    expect(await messagesFor(dto, { ...base, from, to })).toEqual([]);
  });

  it.each([
    ['a week date', '2026-W02-3'],
    ['an ordinal date', '2026-008'],
    ['a date only', '2026-01-01'],
    ['no time zone', '2026-01-01T00:00:00'],
    ['an hour-only offset', '2026-01-01T00:00:00+02'],
    ['free text', 'yesterday'],
  ])('rejects %s with 400', async (_, value) => {
    expect(await messagesFor(dto, { ...base, from: value, to: TO })).toEqual([
      FORMAT('from'),
    ]);
    expect(await messagesFor(dto, { ...base, from: FROM, to: value })).toEqual([
      FORMAT('to'),
    ]);
  });

  it.each([
    ['30 February', '2026-02-30T00:00:00Z'],
    ['29 February in a common year', '2026-02-29T00:00:00Z'],
    ['month 13', '2026-13-01T00:00:00Z'],
    ['hour 24', '2026-01-01T24:00:00Z'],
  ])('rejects an impossible date (%s) with 400', async (_, value) => {
    expect(await messagesFor(dto, { ...base, from: value, to: TO })).toEqual([
      CALENDAR('from'),
    ]);
    expect(await messagesFor(dto, { ...base, from: FROM, to: value })).toEqual([
      CALENDAR('to'),
    ]);
  });
});

describe('required bounds', () => {
  it.each([
    ['GET /api/alerts', AlertsQueryDto, {}],
    ['GET /api/reports/telemetry', ReportQueryDto, { turbineId: 'TURB001' }],
  ] as const)('%s requires from and to', async (_, dto, base) => {
    expect(await messagesFor(dto, { ...base })).toEqual([
      FORMAT('from'),
      FORMAT('to'),
    ]);
  });

  it('GET /api/turbines/:id/telemetry keeps both optional', async () => {
    expect(await messagesFor(TelemetryQueryDto, {})).toEqual([]);
  });
});
