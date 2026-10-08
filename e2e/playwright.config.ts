import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// Browser E2E tests against the docker-compose stack (web :8082 -> api :8080).
// SEED_USER_PASSWORD comes from the repo's single .env, like every other tool here.
const rootEnv = new URL('../.env', import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:8082',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
