import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests: fast, no Docker. Prisma, Redis and other boundaries are mocked.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // Test against the shared package's source, so tests never run against a stale build.
    alias: {
      '@nextera/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['@nextera/testing/setup-unit'],
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/**/*.module.ts', 'src/**/*.spec.ts'],
    },
  },
});
