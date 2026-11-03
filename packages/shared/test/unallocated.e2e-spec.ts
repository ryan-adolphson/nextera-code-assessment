import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedFarmsFromCsv } from '../src/seed/seed-from-csv.js';
import {
  classifyReadings,
  holdReadings,
  importHeld,
  lockUnallocated,
  type ReadingClass,
  type TelemetryRowInput,
} from '../src/wind/unallocated.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const DATA_DIR = fileURLToPath(new URL('../prisma/data', import.meta.url));

const reading = (minute: number): TelemetryRowInput => ({
  turbineId: 'TURB990',
  farmId: 'FARM01',
  timestamp: new Date(Date.parse('2026-03-01T00:00:00Z') + minute * 60_000),
  receivedAt: new Date('2026-03-01T01:00:00Z'),
  powerOutputKw: 2000,
  windSpeedMs: 8,
  rotorRpm: 14,
  bladePitchDeg: 3.6,
  gearboxTempC: 81.6,
});

/** A promise and the function that resolves it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/**
 * The locking between ingestion's hold and the API's actions, made deterministic: an action holds
 * its transaction open at a known point while ingestion runs, and the test checks that ingestion
 * waits for it and then sees the result.
 */
describe('unallocated turbines: hold vs. actions (e2e)', () => {
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_unallocated');
    await m.migrateAll();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    await seedFarmsFromCsv(prisma, DATA_DIR);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await m?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry, held_telemetry, unallocated_turbines`;
    await prisma.turbine.deleteMany({ where: { turbineId: 'TURB990' } });
  });

  const holdOne = (row: TelemetryRowInput) =>
    prisma.$transaction(async (tx) => {
      const [kind] = await classifyReadings(tx, [row]);
      if (kind !== 'unknown_turbine') throw new Error(`classified ${kind}`);
      const [entry] = await holdReadings(tx, [{ ...row, kind }]);
      return entry;
    });

  it('classifies a reading that arrives during an assign only after it commits (then: known)', async () => {
    const entry = await holdOne(reading(0));
    const created = gate();
    const release = gate();

    const assign = prisma.$transaction(
      async (tx) => {
        await lockUnallocated(tx, entry.id);
        await tx.turbine.create({
          data: {
            turbineId: 'TURB990',
            farmId: 'FARM01',
            latitude: 41.25,
            longitude: -96.53,
          },
        });
        created.open();
        await release.opened;
        return importHeld(tx, entry.id, 'FARM01');
      },
      { timeout: 10_000 },
    );
    await created.opened;

    let classified: ReadingClass[] | undefined;
    const ingest = prisma
      .$transaction((tx) => classifyReadings(tx, [reading(5)]))
      .then((kinds) => (classified = kinds));
    await sleep(500);
    // Without the turbine id's lock it would already be 'unknown_turbine' and be held under a new
    // entry for a turbine that exists by then.
    expect(classified).toBeUndefined();

    release.open();
    await expect(assign).resolves.toMatchObject({ imported: 1 });
    await ingest;
    expect(classified).toEqual(['known']);
  });

  it('holds a reading for an entry an action has locked only after that action ends, in the same entry', async () => {
    const entry = await holdOne(reading(0));
    const locked = gate();
    const release = gate();

    // An action that locked the entry and found the turbine id still unknown, then gave up
    // (e.g. a 404 for the farm): the waiting reading is held under the same, still pending entry.
    const action = prisma
      .$transaction(async (tx) => {
        await lockUnallocated(tx, entry.id);
        locked.open();
        await release.opened;
        throw new Error('rolled back');
      })
      .catch(() => undefined);
    await locked.opened;

    let held = false;
    const ingest = holdOne(reading(5)).then(() => (held = true));
    await sleep(500);
    expect(held).toBe(false);

    release.open();
    await action;
    await ingest;
    expect(
      await prisma.heldTelemetry.count({ where: { unallocatedId: entry.id } }),
    ).toBe(2);
  });
});
