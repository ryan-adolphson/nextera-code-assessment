import type { PrismaClient } from '../generated/prisma/client.js';
import type { Role } from '../generated/prisma/enums.js';
import { normalizeEmail } from '../auth/passwords.js';

/** The test users `npm run db:seed` creates, one per role. */
export const SEED_USERS: readonly { email: string; role: Role }[] = [
  { email: 'viewer@nextera.local', role: 'viewer' },
  { email: 'owner@nextera.local', role: 'owner' },
  { email: 'admin@nextera.local', role: 'admin' },
];

/** The seed refuses shorter passwords (and there is no default). */
export const SEED_PASSWORD_MIN_LENGTH = 12;

/**
 * Creates the SEED_USERS, all with `password` (hashed with `hash`, so this package doesn't load
 * the native argon2 module). Idempotent: re-running resets their role, password and `active`.
 */
export async function seedUsers(
  prisma: PrismaClient,
  password: string | undefined,
  hash: (password: string) => Promise<string>,
): Promise<number> {
  if (!password || password.length < SEED_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `SEED_USER_PASSWORD must be set to at least ${SEED_PASSWORD_MIN_LENGTH} characters ` +
        '(the password of the seeded test users; there is no default)',
    );
  }
  for (const user of SEED_USERS) {
    const email = normalizeEmail(user.email);
    const data = {
      role: user.role,
      passwordHash: await hash(password),
      active: true,
    };
    await prisma.user.upsert({
      where: { email },
      create: { email, ...data },
      update: data,
    });
  }
  return SEED_USERS.length;
}
