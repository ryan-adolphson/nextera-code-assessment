import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '../generated/prisma/client.js';
import { parseCsv, seedFromCsv } from './seed-from-csv.js';

const DATA_DIR = fileURLToPath(new URL('../../prisma/data', import.meta.url));

describe('seedFromCsv', () => {
  it('upserts turbines by business key without touching the UUID id or commissioned', async () => {
    const prisma = {
      farm: { upsert: vi.fn() },
      turbine: { upsert: vi.fn() },
      telemetry: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    };

    await seedFromCsv(prisma as unknown as PrismaClient, DATA_DIR);

    expect(prisma.turbine.upsert).toHaveBeenCalledTimes(2);
    const [args] = prisma.turbine.upsert.mock.calls[0];
    expect(args.where).toEqual({ turbineId: 'TURB001' });
    expect(args.create).toEqual(
      expect.objectContaining({ turbineId: 'TURB001', farmId: 'FARM01' }),
    );
    // Postgres generates the id; turbines.csv has no commissioned column, so a re-seed never
    // resets a turbine that was commissioned since.
    for (const data of [args.create, args.update]) {
      expect(data).not.toHaveProperty('id');
      expect(data).not.toHaveProperty('commissioned');
    }
  });
});

describe('parseCsv', () => {
  const columns = ['farm_id', 'farm_name', 'latitude', 'longitude'];

  it('maps rows to objects by header (tolerates CRLF and a trailing newline)', () => {
    const text =
      'farm_id,farm_name,latitude,longitude\r\nFARM01,Prairie Ridge,41.25,-96.53\r\n';

    expect(parseCsv(text, columns)).toEqual([
      {
        farm_id: 'FARM01',
        farm_name: 'Prairie Ridge',
        latitude: '41.25',
        longitude: '-96.53',
      },
    ]);
  });

  it('rejects an unexpected header', () => {
    expect(() => parseCsv('id,name\nFARM01,x', columns)).toThrow(
      /Unexpected CSV header/,
    );
  });

  it('rejects a row with the wrong number of values, naming the line', () => {
    const text =
      'farm_id,farm_name,latitude,longitude\nFARM01,Prairie Ridge,41.25';
    expect(() => parseCsv(text, columns)).toThrow(/line 2/);
  });
});
