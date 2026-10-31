import {
  classifyReadings,
  enabledAlertRules,
  holdReadings,
  insertTelemetryWithAlerts,
  seedFromCsv,
  type HoldableReading,
  type ReadingClass,
  type TelemetryRowInput,
  type UnallocatedTurbineResponse,
} from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import type { Role } from '@nextera/shared';
import { createTestApp, eventsUrl, openSse, type TestApp } from './helpers.js';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
/** TURB001's readings in the fixture (2 days, every 5 minutes). */
const FIXTURE_READINGS = 562;

const reading = (
  overrides: Partial<TelemetryRowInput> = {},
): TelemetryRowInput => ({
  turbineId: 'TURB990',
  farmId: 'FARM01',
  timestamp: new Date('2026-03-01T00:00:00Z'),
  receivedAt: new Date('2026-03-01T00:01:00Z'),
  powerOutputKw: 2000,
  windSpeedMs: 8,
  rotorRpm: 14,
  bladePitchDeg: 3.6,
  gearboxTempC: 81.6,
  ...overrides,
});

const at = (minute: number) =>
  new Date(Date.parse('2026-03-01T00:00:00Z') + minute * 60_000);

/**
 * /api/unallocated-turbines against the CSV fixture (re-seeded for every test). Readings are held
 * with the shared code the ingestion worker runs (classifyReadings → insert known / hold the rest,
 * in one transaction), so these tests cover hold → decide → telemetry end to end.
 */
describe('Unallocated turbines API (e2e)', () => {
  let t: TestApp;

  const reseed = async () => {
    await t.prisma
      .$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config, telemetry, held_telemetry, unallocated_turbines, turbines, farm_weather_hourly, farms`;
    await seedFromCsv(t.prisma, SEED_DATA_DIR);
  };

  beforeAll(async () => {
    t = await createTestApp();
  });

  beforeEach(reseed);

  afterAll(async () => {
    await reseed();
    await t.app.close();
  });

  /** What the ingestion worker does with readings (Pub/Sub or CSV), in one transaction. */
  const ingest = (...rows: TelemetryRowInput[]): Promise<ReadingClass[]> =>
    t.prisma.$transaction(async (tx) => {
      const kinds = await classifyReadings(tx, rows);
      const known = rows.filter((_, i) => kinds[i] === 'known');
      const holdable = rows.flatMap((row, i): HoldableReading[] => {
        const kind = kinds[i];
        return kind === 'known' || kind === 'blocked' ? [] : [{ ...row, kind }];
      });
      if (holdable.length) await holdReadings(tx, holdable);
      if (known.length) {
        await insertTelemetryWithAlerts(tx, known, await enabledAlertRules(tx));
      }
      return kinds;
    });

  const api = (
    method: string,
    path: string,
    { role = 'owner', body }: { role?: Role | null; body?: unknown } = {},
  ) =>
    fetch(`${t.url}/api${path}`, {
      method,
      headers: {
        ...(role ? t.auth(role) : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const list = async (status?: string): Promise<UnallocatedTurbineResponse[]> =>
    (
      await api(
        'GET',
        `/unallocated-turbines${status ? `?status=${status}` : ''}`,
      )
    ).json();

  /** Holds readings for a pair and returns its entry. */
  const hold = async (...rows: TelemetryRowInput[]) => {
    await ingest(...rows);
    const entry = (await list()).find(
      (e) =>
        e.turbineId === rows[0].turbineId &&
        e.reportedFarmId === rows[0].farmId,
    );
    if (!entry) throw new Error('not held');
    return entry;
  };

  const telemetryOf = (turbineId: string) =>
    t.prisma.telemetry.findMany({
      where: { turbineId },
      orderBy: { timestamp: 'asc' },
      include: { alerts: { include: { alert: true } } },
    });

  describe('GET /api/unallocated-turbines', () => {
    it('lists nothing at first, and rejects an unknown status', async () => {
      expect(await list()).toEqual([]);
      expect(await list('blocked')).toEqual([]);
      expect(
        (await api('GET', '/unallocated-turbines?status=gone')).status,
      ).toBe(400);
    });

    it('lists a held unknown turbine and a farm mismatch with what an owner needs to decide', async () => {
      await ingest(
        reading({ timestamp: at(0) }),
        reading({ timestamp: at(5), powerOutputKw: 2100 }),
        reading({ turbineId: 'TURB001', farmId: 'FARM02' }),
        reading({ turbineId: 'TURB992', farmId: 'FARM99' }),
      );

      const entries = await list();
      const byTurbine = Object.fromEntries(
        entries.map((e) => [`${e.turbineId}/${e.reportedFarmId}`, e]),
      );
      expect(Object.keys(byTurbine).sort()).toEqual([
        'TURB001/FARM02',
        'TURB990/FARM01',
        'TURB992/FARM99',
      ]);
      expect(byTurbine['TURB990/FARM01']).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        turbineId: 'TURB990',
        kind: 'unknown_turbine',
        status: 'pending',
        reportedFarmId: 'FARM01',
        reportedFarm: { id: 'FARM01', name: 'Prairie Ridge' },
        currentFarm: null,
        firstSeenAt: expect.any(String),
        lastSeenAt: expect.any(String),
        heldCount: 2,
        latest: {
          turbineId: 'TURB990',
          farmId: 'FARM01',
          timestamp: '2026-03-01T00:05:00.000Z',
          receivedAt: '2026-03-01T00:01:00.000Z',
          powerOutputKw: 2100,
          windSpeedMs: 8,
          rotorRpm: 14,
          bladePitchDeg: 3.6,
          gearboxTempC: 81.6,
        },
        blockedAt: null,
        blockedBy: null,
      });
      expect(byTurbine['TURB001/FARM02']).toMatchObject({
        kind: 'farm_mismatch',
        reportedFarm: { id: 'FARM02', name: 'High Plains' },
        currentFarm: { id: 'FARM01', name: 'Prairie Ridge' },
        heldCount: 1,
      });
      expect(byTurbine['TURB992/FARM99']).toMatchObject({
        kind: 'unknown_turbine',
        reportedFarm: null, // no such farm
      });
      // Held readings never reach telemetry.
      expect(
        await t.prisma.telemetry.count({ where: { turbineId: 'TURB990' } }),
      ).toBe(0);
    });
  });

  describe('GET /api/unallocated-turbines/:id/readings', () => {
    it('returns the newest held readings first, at most limit', async () => {
      const entry = await hold(
        reading({ timestamp: at(0) }),
        reading({ timestamp: at(5) }),
        reading({ timestamp: at(10) }),
      );

      const res = await api(
        'GET',
        `/unallocated-turbines/${entry.id}/readings?limit=2`,
      );
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { timestamp: string }[]).map((r) => r.timestamp),
      ).toEqual(['2026-03-01T00:10:00.000Z', '2026-03-01T00:05:00.000Z']);
    });

    it.each([
      [`/unallocated-turbines/${UNKNOWN_ID}/readings`, 404],
      ['/unallocated-turbines/not-a-uuid/readings', 400],
      [`/unallocated-turbines/${UNKNOWN_ID}/readings?limit=0`, 400],
      [`/unallocated-turbines/${UNKNOWN_ID}/readings?limit=2017`, 400],
    ])('GET %s → %i', async (path, status) => {
      expect((await api('GET', path)).status).toBe(status);
    });
  });

  describe('POST /api/unallocated-turbines/:id/assign', () => {
    it('creates the turbine, imports the held readings with their alerts and resolves the entry; SSE after the commit', async () => {
      const rule = await t.prisma.alertConfig.create({
        data: {
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 100,
          alertLevel: 'error',
        },
      });
      const entry = await hold(
        reading({ timestamp: at(0) }),
        reading({ timestamp: at(5), gearboxTempC: 126.5 }),
      );
      const sse = await openSse(eventsUrl(t, 'viewer'));
      try {
        const res = await api(
          'POST',
          `/unallocated-turbines/${entry.id}/assign`,
          { body: { farmId: 'FARM01' } },
        );

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          action: 'assigned',
          id: entry.id,
          turbine: {
            id: 'TURB990',
            farmId: 'FARM01',
            latitude: 41.25, // the farm's coordinates
            longitude: -96.53,
            commissioned: false,
          },
          imported: 2,
          duplicates: 0,
        });

        const changed = await sse.nextEvent('unallocated-turbine.changed');
        expect(JSON.parse(changed.data)).toEqual({
          action: 'assigned',
          id: entry.id,
          turbineId: 'TURB990',
        });
        // Published after the commit: the change is visible when the event arrives.
        expect(await list()).toEqual([]);
        expect(JSON.parse((await sse.nextEvent('fleet.changed')).data)).toEqual(
          { turbineId: 'TURB990' },
        );
        const live = JSON.parse(
          (await sse.nextEvent('telemetry.received')).data,
        );
        expect(live).toMatchObject({
          turbineId: 'TURB990',
          farmId: 'FARM01',
          timestamp: '2026-03-01T00:05:00.000Z',
          alerts: [{ id: rule.id, alertLevel: 'error' }],
        });
      } finally {
        sse.close();
      }

      const stored = await telemetryOf('TURB990');
      expect(stored.map((r) => [r.farmId, r.alerts.length])).toEqual([
        ['FARM01', 0],
        ['FARM01', 1], // 126.5 °C: evaluated on import
      ]);
      expect(await t.prisma.heldTelemetry.count()).toBe(0);
      const farms = await (
        await api('GET', '/farms', { role: 'viewer' })
      ).json();
      expect(farms[0].turbines.map((tb: { id: string }) => tb.id)).toContain(
        'TURB990',
      );

      // Its next reading is known: stored in telemetry, not held.
      expect(await ingest(reading({ timestamp: at(10) }))).toEqual(['known']);
    });

    it('uses the given coordinates, on another farm than the reported one', async () => {
      const entry = await hold(reading());

      const res = await api(
        'POST',
        `/unallocated-turbines/${entry.id}/assign`,
        {
          body: { farmId: 'FARM03', latitude: 35.12, longitude: -106.55 },
        },
      );

      expect(await res.json()).toMatchObject({
        turbine: {
          id: 'TURB990',
          farmId: 'FARM03',
          latitude: 35.12,
          longitude: -106.55,
        },
      });
      expect((await telemetryOf('TURB990')).map((r) => r.farmId)).toEqual([
        'FARM03',
      ]);
    });

    it.each([
      [{ farmId: 'FARM99' }, 404, 'Farm FARM99 not found'],
      [
        { farmId: 'FARM01', latitude: 41 },
        400,
        'Provide both latitude and longitude, or neither',
      ],
      [{ farmId: 'FARM01', latitude: 91, longitude: 0 }, 400, undefined],
      [{ farmId: '' }, 400, undefined],
      [{}, 400, undefined],
      [{ farmId: 'FARM01', commissioned: true }, 400, undefined],
    ])(
      'rejects %o with %i, holding on to the readings',
      async (body, status, message) => {
        const entry = await hold(reading());

        const res = await api(
          'POST',
          `/unallocated-turbines/${entry.id}/assign`,
          { body },
        );

        expect(res.status).toBe(status);
        if (message) expect((await res.json()).message).toBe(message);
        expect((await list())[0]).toMatchObject({ id: entry.id, heldCount: 1 });
        expect(
          await t.prisma.turbine.count({ where: { turbineId: 'TURB990' } }),
        ).toBe(0);
      },
    );

    it('409s a farm mismatch (the turbine exists: keep or move it)', async () => {
      const entry = await hold(
        reading({ turbineId: 'TURB001', farmId: 'FARM02' }),
      );

      const res = await api(
        'POST',
        `/unallocated-turbines/${entry.id}/assign`,
        {
          body: { farmId: 'FARM02' },
        },
      );

      expect(res.status).toBe(409);
      expect((await res.json()).message).toBe(
        'Turbine TURB001 already exists on FARM01: keep or move it instead',
      );
    });

    it('lets one of two concurrent assigns win; the other gets 404, and the readings are imported once', async () => {
      const entry = await hold(
        reading({ timestamp: at(0) }),
        reading({ timestamp: at(5) }),
      );

      const responses = await Promise.all(
        ['FARM01', 'FARM02'].map((farmId) =>
          api('POST', `/unallocated-turbines/${entry.id}/assign`, {
            body: { farmId },
          }),
        ),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([200, 404]);
      const stored = await telemetryOf('TURB990');
      expect(stored).toHaveLength(2);
      expect(new Set(stored.map((r) => r.farmId)).size).toBe(1);
    });

    it('never strands a reading that arrives while the turbine is being assigned', async () => {
      for (let round = 0; round < 5; round++) {
        await reseed();
        const entry = await hold(reading({ timestamp: at(0) }));

        await Promise.all([
          api('POST', `/unallocated-turbines/${entry.id}/assign`, {
            body: { farmId: 'FARM01' },
          }),
          ingest(reading({ timestamp: at(5) })),
        ]);

        // Either held before the assign (and imported by it), or known after it: never left pending.
        expect(await list()).toEqual([]);
        expect((await telemetryOf('TURB990')).map((r) => r.timestamp)).toEqual([
          at(0),
          at(5),
        ]);
      }
    });
  });

  describe('POST /api/unallocated-turbines/:id/keep', () => {
    it('imports a mismatch’s held readings under the turbine’s own farm, with alerts', async () => {
      await t.prisma.alertConfig.create({
        data: {
          measurementMetric: 'bladePitchDeg',
          comparison: 'above',
          valueMetric: 30,
          alertLevel: 'info',
        },
      });
      const entry = await hold(
        reading({ turbineId: 'TURB001', farmId: 'FARM02', bladePitchDeg: 44 }),
      );

      const res = await api('POST', `/unallocated-turbines/${entry.id}/keep`);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        action: 'kept',
        turbine: { id: 'TURB001', farmId: 'FARM01' },
        imported: 1,
        duplicates: 0,
      });
      const kept = await t.prisma.telemetry.findUniqueOrThrow({
        where: {
          turbineId_timestamp: { turbineId: 'TURB001', timestamp: at(0) },
        },
        include: { alerts: true },
      });
      expect(kept.farmId).toBe('FARM01');
      expect(kept.alerts).toHaveLength(1);
      expect(await list()).toEqual([]);
    });

    it('409s an unknown turbine (assign it instead)', async () => {
      const entry = await hold(reading());
      const res = await api('POST', `/unallocated-turbines/${entry.id}/keep`);
      expect(res.status).toBe(409);
    });
  });

  describe('POST /api/unallocated-turbines/:id/move', () => {
    it('moves the turbine and its whole history to the reported farm, then imports the held readings', async () => {
      const rule = await t.prisma.alertConfig.create({
        data: {
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 120,
          alertLevel: 'error',
        },
      });
      // A fixture reading flagged before the move keeps its alert.
      const flagged = await t.prisma.telemetry.findFirstOrThrow({
        where: { turbineId: 'TURB001' },
      });
      await t.prisma.telemetryAlert.create({
        data: { telemetryId: flagged.id, alertId: rule.id },
      });
      const entry = await hold(
        reading({ turbineId: 'TURB001', farmId: 'FARM02' }),
      );
      const sse = await openSse(eventsUrl(t, 'viewer'));
      try {
        const res = await api('POST', `/unallocated-turbines/${entry.id}/move`);

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          action: 'moved',
          turbine: { id: 'TURB001', farmId: 'FARM02' },
          imported: 1,
        });
        expect(
          JSON.parse((await sse.nextEvent('unallocated-turbine.changed')).data),
        ).toMatchObject({ action: 'moved', turbineId: 'TURB001' });
        expect(JSON.parse((await sse.nextEvent('fleet.changed')).data)).toEqual(
          {
            turbineId: 'TURB001',
          },
        );
      } finally {
        sse.close();
      }

      const counts = await t.prisma.telemetry.groupBy({
        by: ['farmId'],
        where: { turbineId: 'TURB001' },
        _count: true,
      });
      expect(counts).toEqual([
        { farmId: 'FARM02', _count: FIXTURE_READINGS + 1 },
      ]);
      expect(
        await t.prisma.telemetryAlert.count({
          where: { telemetryId: flagged.id },
        }),
      ).toBe(1);
      // The farm's report follows: FARM01 no longer includes TURB001.
      const report = await (
        await api(
          'GET',
          '/reports/telemetry?farmId=FARM01&from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z',
        )
      ).json();
      expect(report.readings).toEqual([]);
    });

    it('409s when the reported farm does not exist', async () => {
      const entry = await hold(
        reading({ turbineId: 'TURB001', farmId: 'FARM99' }),
      );

      const res = await api('POST', `/unallocated-turbines/${entry.id}/move`);

      expect(res.status).toBe(409);
      expect((await res.json()).message).toBe(
        'Farm FARM99 does not exist: keep TURB001 in FARM01 or block it',
      );
      expect(
        (
          await t.prisma.turbine.findUniqueOrThrow({
            where: { turbineId: 'TURB001' },
          })
        ).farmId,
      ).toBe('FARM01');
    });
  });

  describe('block and unblock', () => {
    it('blocks a pair (who and when), drops its later readings, and unblocking re-creates the entry on the next reading', async () => {
      const entry = await hold(reading({ turbineId: 'TURB991' }));

      const res = await api('POST', `/unallocated-turbines/${entry.id}/block`);

      expect(res.status).toBe(200);
      const blocked = (await res.json()) as UnallocatedTurbineResponse;
      expect(blocked).toMatchObject({
        id: entry.id,
        status: 'blocked',
        heldCount: 0,
        latest: null,
        blockedBy: 'owner@nextera.local',
      });
      expect(
        Math.abs(Date.parse(blocked.blockedAt!) - Date.now()),
      ).toBeLessThan(60_000);
      expect(await t.prisma.heldTelemetry.count()).toBe(0);
      expect(await list()).toEqual([]);
      expect(await list('blocked')).toEqual([blocked]);

      // Dropped from now on; the same turbine on another farm is still held.
      expect(
        await ingest(
          reading({ turbineId: 'TURB991', timestamp: at(5) }),
          reading({ turbineId: 'TURB991', farmId: 'FARM02', timestamp: at(5) }),
        ),
      ).toEqual(['blocked', 'unknown_turbine']);
      expect(
        await t.prisma.heldTelemetry.count({ where: { farmId: 'FARM01' } }),
      ).toBe(0);

      for (const action of ['block', 'assign', 'keep', 'move']) {
        const again = await api(
          'POST',
          `/unallocated-turbines/${entry.id}/${action}`,
          {
            body: action === 'assign' ? { farmId: 'FARM01' } : undefined,
          },
        );
        expect(again.status, action).toBe(409);
      }

      const unblock = await api(
        'POST',
        `/unallocated-turbines/${entry.id}/unblock`,
      );
      expect(unblock.status).toBe(204);
      expect(await list('blocked')).toEqual([]);

      await ingest(reading({ turbineId: 'TURB991', timestamp: at(10) }));
      const pending = (await list()).filter(
        (e) => e.reportedFarmId === 'FARM01',
      );
      expect(pending).toEqual([
        expect.objectContaining({
          turbineId: 'TURB991',
          status: 'pending',
          heldCount: 1,
        }),
      ]);
      expect(pending[0].id).not.toBe(entry.id);
    });

    it('409s unblocking a pending entry, 404s an unknown one', async () => {
      const entry = await hold(reading());
      expect(
        (await api('POST', `/unallocated-turbines/${entry.id}/unblock`)).status,
      ).toBe(409);
      expect(
        (await api('POST', `/unallocated-turbines/${UNKNOWN_ID}/unblock`))
          .status,
      ).toBe(404);
      expect(
        (await api('POST', `/unallocated-turbines/${UNKNOWN_ID}/block`)).status,
      ).toBe(404);
    });
  });

  describe('access', () => {
    it.each([
      ['GET', '/unallocated-turbines'],
      ['GET', `/unallocated-turbines/${UNKNOWN_ID}/readings`],
      ['POST', `/unallocated-turbines/${UNKNOWN_ID}/assign`],
      ['POST', `/unallocated-turbines/${UNKNOWN_ID}/keep`],
      ['POST', `/unallocated-turbines/${UNKNOWN_ID}/move`],
      ['POST', `/unallocated-turbines/${UNKNOWN_ID}/block`],
      ['POST', `/unallocated-turbines/${UNKNOWN_ID}/unblock`],
    ])(
      '%s %s: viewer 404 (as if it did not exist), no token 401, admin allowed',
      async (method, path) => {
        const viewer = await api(method, path, { role: 'viewer' });
        expect(viewer.status).toBe(404);
        expect((await viewer.json()).message).toBe(
          `Cannot ${method} /api${path}`,
        );

        const anonymous = await api(method, path, { role: null });
        expect(anonymous.status).toBe(401);

        const admin = await api(method, path, {
          role: 'admin',
          body: path.endsWith('/assign') ? { farmId: 'FARM01' } : undefined,
        });
        expect(admin.status).not.toBe(401);
        expect(await admin.text()).not.toContain(`Cannot ${method}`);
      },
    );
  });
});
