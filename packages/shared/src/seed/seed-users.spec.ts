import type { PrismaClient } from '../generated/prisma/client.js';
import { SEED_USERS, seedUsers } from './seed-users.js';

describe('seedUsers', () => {
  const upsert = vi.fn();
  const prisma = { user: { upsert } } as unknown as PrismaClient;
  const hash = vi.fn(async (pw: string) => `hashed:${pw}`);

  beforeEach(() => {
    upsert.mockReset();
    hash.mockClear();
  });

  it.each([undefined, '', 'short'])(
    'refuses to run without a long enough SEED_USER_PASSWORD (%j) and writes nothing',
    async (password) => {
      await expect(seedUsers(prisma, password, hash)).rejects.toThrow(
        /SEED_USER_PASSWORD must be set/,
      );
      expect(upsert).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    },
  );

  it('upserts one user per role by email, with the hash and never the password', async () => {
    expect(await seedUsers(prisma, 'correct horse battery', hash)).toBe(3);

    expect(SEED_USERS.map((u) => u.role)).toEqual(['viewer', 'owner', 'admin']);
    expect(upsert).toHaveBeenCalledTimes(3);
    expect(upsert).toHaveBeenCalledWith({
      where: { email: 'owner@nextera.local' },
      create: {
        email: 'owner@nextera.local',
        role: 'owner',
        passwordHash: 'hashed:correct horse battery',
        active: true,
      },
      // Re-running resets role, password and active (idempotent).
      update: {
        role: 'owner',
        passwordHash: 'hashed:correct horse battery',
        active: true,
      },
    });
    expect(JSON.stringify(upsert.mock.calls)).not.toContain(
      '"correct horse battery"',
    );
  });
});
