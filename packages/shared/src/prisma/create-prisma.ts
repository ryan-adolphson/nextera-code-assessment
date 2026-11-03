import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * A Prisma client for a plain Node process (scripts, Cloud Run Jobs) that has no Nest
 * `PrismaService`. Keep `max` small: these connections are outside the services' connection budget
 * ((api + ingestion instances) × DB_POOL_MAX).
 */
export function createPrismaClient(
  connectionString: string,
  { max = 2 }: { max?: number } = {},
): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, max }),
  });
}
