import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `npm run load:test`. load/ isn't a workspace, so the root `npm test` doesn't reach it.
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@nextera/shared': fileURLToPath(
        new URL('../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['*.spec.js'],
    setupFiles: ['@nextera/testing/setup-unit'],
  },
});
