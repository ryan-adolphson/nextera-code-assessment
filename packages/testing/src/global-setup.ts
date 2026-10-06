import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

// Migrations are owned by the shared package.
const sharedDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../shared');

/**
 * Vitest globalSetup for e2e tests of any service: starts throwaway Postgres + Redis (same major
 * versions as compose / GCP) and applies the shared Prisma migrations.
 */
export default async function setup(project: TestProject) {
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18-alpine').start(),
    new RedisContainer('redis:8-alpine').start(),
  ]);

  const databaseUrl = postgres.getConnectionUri();
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: sharedDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });

  project.provide('databaseUrl', databaseUrl);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
