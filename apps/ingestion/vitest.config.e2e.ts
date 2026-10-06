import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// E2E tests: the real AppModule against Testcontainers Postgres + Redis (needs Docker).
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@nextera/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['../../packages/testing/src/global-setup.ts'],
    setupFiles: ['@nextera/testing/setup-e2e'],
    fileParallelism: false, // files share one database
    testTimeout: 20_000,
    hookTimeout: 120_000, // first run pulls images
  },
});
