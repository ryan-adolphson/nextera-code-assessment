import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// One .env at the repo root. Real environment variables (compose, Cloud Run, CI) take precedence.
config({ path: ['.env', '../../.env'], quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Empty fallback lets `prisma generate` run without a database (e.g. in the Docker build).
    url: process.env.DATABASE_URL ?? '',
  },
});
