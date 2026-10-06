import { defineConfig } from 'vitest/config';

// Migration tests: real `prisma migrate deploy` against Testcontainers Postgres (needs Docker).
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['../testing/src/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000, // runs the Prisma CLI several times
    hookTimeout: 120_000, // first run pulls images
  },
});
