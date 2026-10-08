import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createTestApp, type TestApp } from './helpers.js';

const HEADER =
  'turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('CSV upload: POST /ingest/telemetry (e2e, real Postgres + Redis)', () => {
  let t: TestApp;
  let providedCsv: string;
  let lastEventId: string;

  beforeAll(async () => {
    t = await createTestApp();
    providedCsv = await readFile(join(SEED_DATA_DIR, 'telemetry.csv'), 'utf8');
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await t.prisma.$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry`;
    lastEventId = (await t.events.publish('test.marker', null)).id;
  });

  /** multipart/form-data upload, like `curl -F file=@readings.csv`. */
  function upload(content: string | Uint8Array<ArrayBuffer>, field = 'file') {
    const form = new FormData();
    form.append(
      field,
      new Blob([content], { type: 'text/csv' }),
      'readings.csv',
    );
    return fetch(`${t.url}/ingest/telemetry`, { method: 'POST', body: form });
  }

  const publishedEvents = () => t.events.since(lastEventId);

  it('stores the provided telemetry.csv (1,122 rows) and returns counts', async () => {
    const res = await upload(providedCsv);

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      rows: 1122,
      inserted: 1122,
      duplicates: 0,
      turbines: ['TURB001', 'TURB002'],
    });
    expect(await t.prisma.telemetry.count()).toBe(1122);

    // received_at from the file is kept: the first row arrived 2 minutes late.
    const first = await t.prisma.telemetry.findUniqueOrThrow({
      where: {
        turbineId_timestamp: {
          turbineId: 'TURB001',
          timestamp: new Date('2026-01-01T00:00:00Z'),
        },
      },
    });
    expect(first.receivedAt).toEqual(new Date('2026-01-01T00:02:00Z'));
  });

  it('publishes one live update per turbine (its newest reading), not one per row', async () => {
    await upload(providedCsv);

    const events = await publishedEvents();
    expect(events.map((e) => e.type)).toEqual([
      'telemetry.received',
      'telemetry.received',
    ]);
    expect(
      events.map((e) => e.data as { turbineId: string; timestamp: string }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          turbineId: 'TURB001',
          timestamp: '2026-01-02T23:55:00.000Z',
        }),
        expect.objectContaining({
          turbineId: 'TURB002',
          timestamp: '2026-01-02T23:55:00.000Z',
        }),
      ]),
    );
  });

  it('is idempotent: re-uploading the same file stores and publishes nothing new', async () => {
    await upload(providedCsv);
    lastEventId = (await t.events.publish('test.marker', null)).id;

    const res = await upload(providedCsv);

    expect(await res.json()).toMatchObject({
      rows: 1122,
      inserted: 0,
      duplicates: 1122,
    });
    expect(await t.prisma.telemetry.count()).toBe(1122);
    expect(await publishedEvents()).toHaveLength(0);
  });

  it('inserts only the new rows of a file that overlaps existing data, using upload time for empty received_at', async () => {
    await upload(
      csv(
        'TURB001,FARM01,2026-03-01T00:00:00Z,2026-03-01T00:02:00Z,2000,7,12,4,80',
      ),
    );
    const before = Date.now();

    const res = await upload(
      csv(
        'TURB001,FARM01,2026-03-01T00:00:00Z,2026-03-01T00:02:00Z,2000,7,12,4,80', // existing
        'TURB001,FARM01,2026-03-01T00:05:00Z,,2100,7.5,12.5,4,81', // new, no received_at
      ),
    );

    expect(await res.json()).toMatchObject({
      rows: 2,
      inserted: 1,
      duplicates: 1,
    });
    const added = await t.prisma.telemetry.findFirstOrThrow({
      where: { timestamp: new Date('2026-03-01T00:05:00Z') },
    });
    expect(added.receivedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('stores the alert rules each new row triggers (enabled rules only)', async () => {
    const hot = await t.prisma.alertConfig.create({
      data: {
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 120,
        alertLevel: 'error',
      },
    });
    await t.prisma.alertConfig.create({
      data: {
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 90,
        alertLevel: 'warn',
        enabled: false,
      },
    });
    try {
      const res = await upload(
        csv(
          'TURB001,FARM01,2026-03-01T00:00:00Z,,2000,8,14,3.6,126.5',
          'TURB001,FARM01,2026-03-01T00:05:00Z,,2000,8,14,3.6,95',
        ),
      );
      expect(res.status).toBe(201);

      const links = await t.prisma.telemetryAlert.findMany({
        include: { telemetry: true },
      });
      expect(links.map((l) => [l.telemetry.gearboxTempC, l.alertId])).toEqual([
        [126.5, hot.id],
      ]);
    } finally {
      await t.prisma
        .$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config`;
    }
  });

  it('rejects a file with invalid rows: errors by line, nothing stored', async () => {
    const res = await upload(
      csv(
        'TURB001,FARM01,2026-03-01T00:00:00Z,,2000,7,12,4,80', // valid
        'TURB001,FARM01,yesterday,,2000,7,12,4,80',
        'TURB001,FARM01,2026-03-01T00:10:00Z,,-1,7,12,4,80',
      ),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      message: 'The CSV file contains invalid rows',
      errorCount: 2,
      errors: [
        { line: 3, errors: [expect.stringContaining('timestamp')] },
        { line: 4, errors: ['power_output_kw must not be less than 0'] },
      ],
    });
    expect(await t.prisma.telemetry.count()).toBe(0);
  });

  it('rejects unknown turbines and farm mismatches by line, storing nothing', async () => {
    const res = await upload(
      csv(
        'TURB001,FARM01,2026-03-01T00:00:00Z,,2000,7,12,4,80',
        'TURB999,FARM01,2026-03-01T00:00:00Z,,2000,7,12,4,80',
        'TURB002,FARM01,2026-03-01T00:00:00Z,,2000,7,12,4,80',
      ),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([
      { line: 3, errors: ['Unknown turbine TURB999'] },
      { line: 4, errors: ['Turbine TURB002 belongs to FARM02, not FARM01'] },
    ]);
    expect(await t.prisma.telemetry.count()).toBe(0);
    expect(await publishedEvents()).toHaveLength(0);
  });

  it('reports format errors and unknown turbines together, so one attempt shows everything', async () => {
    const res = await upload(
      csv(
        'TURB003,FARM01,2026-03-01T00:00:00Z,,2000,7,12,4,80',
        'TURB002,FARM02,03/01/2026,,1902.7,,12.0,4.6,79.4',
      ),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([
      { line: 2, errors: ['Unknown turbine TURB003'] },
      {
        line: 3,
        errors: [
          'wind_speed_ms is required',
          'timestamp must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
        ],
      },
    ]);
  });

  it('reports a week-date timestamp as a line error (400, not 500) and stores nothing', async () => {
    const res = await upload(
      csv(
        'TURB001,FARM01,2026-03-01T00:00:00Z,,2000,7,12,4,80',
        'TURB001,FARM01,2026-W02-3,,2000,7,12,4,80',
      ),
    );

    expect(res.status).toBe(400);
    expect((await res.json()).errors).toEqual([
      {
        line: 3,
        errors: [
          'timestamp must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
        ],
      },
    ]);
    expect(await t.prisma.telemetry.count()).toBe(0);
    expect(await publishedEvents()).toHaveLength(0);
  });

  it('rejects a file with the wrong columns', async () => {
    const res = await upload(
      'turbine,time,power\nTURB001,2026-03-01T00:00:00Z,1',
    );

    expect(res.status).toBe(400);
    expect((await res.json()).message).toContain('Unexpected CSV header');
  });

  it('rejects a request without a file', async () => {
    const res = await upload(csv('x'), 'not-file');
    expect(res.status).toBe(400);

    const empty = await fetch(`${t.url}/ingest/telemetry`, { method: 'POST' });
    expect(empty.status).toBe(400);
    expect((await empty.json()).message).toContain('multipart field "file"');
  });

  it('rejects files over 10 MB with 413', async () => {
    const res = await upload(new Uint8Array(10 * 1024 * 1024 + 1).fill(65));
    expect(res.status).toBe(413);
  });
});
