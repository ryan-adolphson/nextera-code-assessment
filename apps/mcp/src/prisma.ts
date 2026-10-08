import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@nextera/shared';

/**
 * Session settings of every pooled connection. `default_transaction_read_only` makes Postgres
 * reject any write with SQLSTATE 25006 (read_only_sql_transaction), so the server stays read-only
 * even if a bug slips in; `statement_timeout` stops a runaway query. A session could still turn
 * the setting off with SET, so in GCP also use a database role that has only SELECT
 * (MCP_DATABASE_URL).
 */
export const SESSION_OPTIONS =
  '-c default_transaction_read_only=on -c statement_timeout=30000';

/** A local, single-user process: two connections are plenty. */
export const POOL_MAX = 2;

/**
 * A Prisma client whose connections are read-only sessions. Refuses a URL with its own `options`
 * parameter: node-postgres lets URL parameters override the pool config, which would drop the
 * read-only setting.
 */
export function createReadOnlyPrisma(connectionString: string): PrismaClient {
  if (/[?&]options=/.test(connectionString)) {
    throw new Error(
      'The database URL must not set "options": the MCP server sets its own (read-only sessions)',
    );
  }
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      max: POOL_MAX,
      options: SESSION_OPTIONS,
    }),
  });
}
