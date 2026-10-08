import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Unit tests: fast, no Docker. Prisma is mocked.
export default defineConfig({
  resolve: {
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
  },
});
