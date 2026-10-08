import { defineConfig } from 'vitest/config';

// Loaded by `ng test` through `runnerConfig` in angular.json; the builder merges `test` into the
// project it generates (files, environment and setup files stay the builder's).
export default defineConfig({
  test: {
    // Pages with charts render up to six ECharts SVG charts in jsdom: 1.4–2.3 s per test on a
    // 10-core Mac, several times that on a 2–4 vCPU CI runner with the other spec files running in
    // parallel, which crossed Vitest's 5 s default. 30 s leaves >10x headroom over the slowest
    // test; a test that really hangs still fails, with "Test timed out in 30000ms".
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
