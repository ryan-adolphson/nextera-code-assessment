/**
 * npm run demo:reset: a fresh, current demo on the local stack, in one command.
 *   1. Checks the target (DATABASE_URL must be localhost or the compose Postgres unless
 *      --allow-remote) and asks for confirmation (--yes skips it; required without a terminal).
 *   2. Stops the compose demo-feed if it runs (so it can't publish while the readings are re-seeded).
 *   3. Deletes the readings in one transaction: telemetry_alerts, telemetry, held_telemetry,
 *      unallocated_turbines, farm_weather and the farm rollups (rows, dirty markers, watermark).
 *      Farms, turbines, users and alert rules stay.
 *   4. Seeds the test users and 7 days (DEMO_RESET_HOURS) of demo data up to now (SEED_NOW
 *      overrides), with the anomalies and the 20 stale turbines (DEMO_ANOMALIES lagging and stopped),
 *      then runs the farm rollup (a full run: the watermark was deleted).
 *   5. Syncs the farm weather for those days (Open-Meteo; a failure is a warning). --no-weather skips.
 *   6. Publishes one demo feed tick from this machine and (re)starts the compose demo-feed with
 *      DEMO_FEED_ENABLED=true (a shell override: .env is never edited), rebuilding its image first
 *      unless --no-build. Without the compose stack it prints the command to run. --no-feed skips.
 * Never prints DATABASE_URL (only host, port and database).
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  DEMO_RESET_HOURS,
  DEMO_RESET_USAGE,
  assertResetTarget,
  clearDemoReadings,
  confirmDemoReset,
  countByPill,
  databaseTarget,
  demoStaleTurbines,
  describeTarget,
  expectedStalenessPill,
  parseDemoResetArgs,
} from '../src/seed/demo-reset.js';
import { parseDemoSeedEnv, seedDemo } from '../src/seed/seed-demo.js';
import { SEED_PASSWORD_MIN_LENGTH } from '../src/seed/seed-users.js';
import { floorToTelemetryStep } from '../src/seed/generate-telemetry.js';
import { utcDay } from '../src/weather/open-meteo.js';
import { ensureTelemetryPartitions } from '../src/wind/partitions.js';
import { syncFarmWeather } from '../src/weather/sync-weather.js';
import { DATA_DIR, rollupAfterSeed, seedTestUsers } from './seed-support.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const FEED_COMMAND = 'DEMO_FEED_ENABLED=true npm run demo:feed';

const step = (n: number, text: string) => console.log(`\n[${n}/6] ${text}`);
const warn = (text: string) => console.warn(`  WARNING: ${text}`);

/** Runs a command in the repo root; output is captured unless `inherit`. */
function run(
  command: string,
  args: string[],
  { inherit = false, env }: { inherit?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const options: SpawnSyncOptions = {
    cwd: REPO_ROOT,
    env: env ?? process.env,
    encoding: 'utf8',
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : 'pipe',
  };
  const result = spawnSync(command, args, options);
  return {
    ok: result.status === 0,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/** The compose services that are running (empty without Docker or the stack). */
function runningComposeServices(): Set<string> {
  const ps = run('docker', [
    'compose',
    'ps',
    '--status',
    'running',
    '--services',
  ]);
  return new Set(ps.ok ? ps.stdout.split('\n').filter(Boolean) : []);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(DEMO_RESET_USAGE);
    return 0;
  }
  let args;
  try {
    args = parseDemoResetArgs(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n${DEMO_RESET_USAGE}`);
    return 1;
  }

  // 1. Safety: target, prerequisites, confirmation. Nothing is written before this passes.
  step(1, 'Checking the target');
  const target = databaseTarget(process.env.DATABASE_URL);
  console.log(
    `  Target database: ${describeTarget(target)} (${target.local ? 'local' : 'REMOTE'})`,
  );
  assertResetTarget(target, args);
  const password = process.env.SEED_USER_PASSWORD;
  if (!password || password.length < SEED_PASSWORD_MIN_LENGTH) {
    throw new Error(
      `SEED_USER_PASSWORD must be set to at least ${SEED_PASSWORD_MIN_LENGTH} characters (the test users' password)`,
    );
  }
  const { end } = parseDemoSeedEnv({ SEED_NOW: process.env.SEED_NOW });
  const confirmed = await confirmDemoReset({
    yes: args.yes,
    interactive: Boolean(process.stdin.isTTY),
    target,
    ask: async (question) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  });
  if (!confirmed) {
    console.log('  Not confirmed: nothing was changed.');
    return 1;
  }

  // The feed only feeds the local stack: never touch it for a remote target.
  const useFeed = args.feed && target.local;
  let compose = useFeed ? runningComposeServices() : new Set<string>();
  if (compose.has('demo-feed')) {
    console.log(
      '  Stopping the compose demo-feed while the readings are re-seeded',
    );
    if (!run('docker', ['compose', 'stop', 'demo-feed']).ok) {
      warn('could not stop the compose demo-feed');
    }
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      max: 2,
    }),
  });
  try {
    // 2. Clear the readings.
    step(2, 'Deleting the readings (one transaction)');
    const cleared = await clearDemoReadings(prisma);
    console.log(
      `  Deleted ${cleared.telemetry} telemetry rows, ${cleared.telemetryAlerts} telemetry_alerts, ` +
        `${cleared.heldTelemetry} held readings, ${cleared.unallocatedTurbines} unallocated entries, ` +
        `${cleared.farmWeather} weather rows, ${cleared.farmRollups} farm rollup rows, ` +
        `${cleared.turbineLatest} latest readings, ${cleared.farmLiveSummary} live summaries, ${cleared.anomalyEpisodes} anomaly episodes. ` +
        'Farms, turbines, users and alert rules kept.',
    );

    // 3. Seed.
    step(
      3,
      `Seeding ${DEMO_RESET_HOURS} h of demo data up to ${end.toISOString()}`,
    );
    const users = await seedTestUsers(prisma);
    // Daily partitions for the window first, so the readings don't pile up in DEFAULT.
    await ensureTelemetryPartitions(
      prisma,
      new Date(end.getTime() - DEMO_RESET_HOURS * 3_600_000),
      end,
    );
    const seedStarted = Date.now();
    const seeded = await seedDemo(prisma, {
      dataDir: DATA_DIR,
      end,
      hours: DEMO_RESET_HOURS,
    });
    const unallocated = seeded.unallocated.filter((u) => u.status);
    console.log(
      `  ${seeded.farms} farms, ${seeded.turbines} demo turbines, ${users} users, ` +
        `${seeded.rulesCreated} default rules created (${seeded.rulesEvaluated} enabled), ` +
        `${seeded.inserted} readings from ${seeded.from} to ${seeded.to}, ${seeded.alerts} triggered alerts, ` +
        `${unallocated.length} unallocated entries (${unallocated.map((u) => `${u.turbineId}@${u.reportedFarmId} ${u.status}`).join(', ')}) ` +
        `in ${((Date.now() - seedStarted) / 1000).toFixed(1)} s`,
    );
    console.log(`  ${(await rollupAfterSeed(prisma)).replace(/,$/, '')}`);

    // 4. Weather.
    step(4, 'Syncing the farm weather');
    let weather = 'skipped (--no-weather)';
    if (args.weather) {
      const now = new Date();
      const last = end.getTime() < now.getTime() ? end : now;
      const from = utcDay(
        new Date(end.getTime() - DEMO_RESET_HOURS * 3_600_000),
      );
      const to = utcDay(last);
      try {
        const result = await syncFarmWeather(prisma, {
          from,
          to,
          now,
          apiKey: process.env.OPEN_METEO_API_KEY || undefined,
          log: (line) => console.log(`  ${line}`),
        });
        const written = result.farms.reduce((n, f) => n + f.written, 0);
        weather = `${result.farms.length - result.failed}/${result.farms.length} farms, ${written} rows (${from}..${to})`;
        if (result.failed)
          warn(`weather sync: ${result.failed} farms failed; continuing`);
      } catch (error) {
        weather = 'failed';
        warn(
          `weather sync failed (${(error as Error).message}); continuing without weather`,
        );
      }
      console.log(`  Weather: ${weather}`);
    } else {
      console.log('  Skipped (--no-weather)');
    }

    // 5. Live feed.
    step(5, 'Live demo feed');
    let feed: string;
    let ticked = false;
    if (!useFeed) {
      feed = args.feed
        ? `not started (remote target). For the local stack: ${FEED_COMMAND}`
        : 'skipped (--no-feed)';
      console.log(`  ${feed}`);
    } else {
      compose = runningComposeServices();
      const feedEnv = {
        ...process.env,
        DEMO_FEED_ENABLED: 'true',
        // No GCE metadata server here (as in compose): silences MetadataLookupWarning.
        METADATA_SERVER_DETECTION: 'none',
      };
      if (compose.has('pubsub')) {
        console.log('  One tick now (npm run demo:feed -- --once)');
        ticked = run(
          'npm',
          ['run', 'demo:feed', '-w', '@nextera/ingestion', '--', '--once'],
          { inherit: true, env: feedEnv },
        ).ok;
        if (!ticked) warn('the immediate feed tick failed');
      }
      if (compose.has('pubsub') && compose.has('ingestion')) {
        const startedAt = new Date();
        console.log(
          `  (Re)starting the compose demo-feed with DEMO_FEED_ENABLED=true` +
            (args.build
              ? ' (rebuilding its image first; --no-build skips that)'
              : ' (--no-build: the existing image, which may run older feed code)'),
        );
        const up = run(
          'docker',
          [
            'compose',
            'up',
            '-d',
            '--no-deps',
            '--force-recreate',
            ...(args.build ? ['--build'] : []),
            'demo-feed',
          ],
          { inherit: true, env: feedEnv },
        );
        feed = up.ok
          ? await composeFeedStatus(startedAt)
          : `failed to start the compose demo-feed. Run: ${FEED_COMMAND}`;
      } else {
        feed =
          `not started: the compose stack isn't running (needs pubsub and ingestion). ` +
          `Start it (docker compose up -d --wait --build api ingestion), then run: ${FEED_COMMAND}`;
      }
      console.log(`  Feed: ${feed}`);
      if (ticked) await waitForTick(prisma);
    }

    // 6. Summary.
    step(6, 'Summary');
    const now = Date.now();
    const stale = demoStaleTurbines();
    const latest = await prisma.telemetry.groupBy({
      by: ['turbineId'],
      where: { turbineId: { in: stale.map((s) => s.turbineId) } },
      _max: { timestamp: true },
    });
    console.log(
      `  Target ${describeTarget(target)}: deleted ${cleared.telemetry} readings; seeded ${seeded.inserted} readings ` +
        `(${seeded.alerts} alerts) for ${seeded.turbines} turbines over ${DEMO_RESET_HOURS} h; weather: ${weather}.`,
    );
    console.log('  Stale turbines (latest reading → expected pill now):');
    const pills: string[] = [];
    for (const s of stale) {
      const at = latest.find((l) => l.turbineId === s.turbineId)?._max
        .timestamp;
      const age = at ? (now - at.getTime()) / 60_000 : null;
      pills.push(age === null ? 'no readings' : expectedStalenessPill(age));
      console.log(
        `    ${s.turbineId} (${s.farmId}, ${s.kind}, ${s.minutesBehind} min behind): ` +
          (at && age !== null
            ? `${at.toISOString()}, ${age.toFixed(1)} min old → ${expectedStalenessPill(age)}`
            : 'no readings'),
      );
    }
    console.log(
      `  ${stale.length} of ${seeded.turbines} turbines stale: ` +
        countByPill(pills)
          .map(([pill, n]) => `${n} × ${pill}`)
          .join(', '),
    );
    console.log(`  Live feed: ${feed}`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

/** Waits up to 30 s for the feed's first log line since `since`. */
async function composeFeedStatus(since: Date): Promise<string> {
  for (let i = 0; i < 15; i++) {
    const logs = run('docker', [
      'compose',
      'logs',
      '--no-log-prefix',
      '--since',
      since.toISOString(),
      'demo-feed',
    ]).stdout;
    const line = logs
      .split('\n')
      .reverse()
      .find(
        (l) =>
          l.includes('Demo feed: published') ||
          l.includes('Demo feed disabled'),
      );
    if (line?.includes('published')) {
      return `running in compose (demo-feed, every ${process.env.DEMO_FEED_INTERVAL_SECONDS ?? 300} s): ${line.trim()}`;
    }
    if (line) return `compose demo-feed is disabled: ${line.trim()}`;
    await sleep(2000);
  }
  return 'compose demo-feed started, but no tick logged yet (docker compose logs -f demo-feed)';
}

/** Gives ingestion up to 30 s to store the tick (Pub/Sub push), so the summary shows it. */
async function waitForTick(prisma: PrismaClient): Promise<void> {
  const boundary = floorToTelemetryStep(Date.now());
  for (let i = 0; i < 15; i++) {
    const count = await prisma.telemetry.count({
      where: { timestamp: { gte: boundary }, turbineId: 'TURB003' },
    });
    if (count) return;
    await sleep(2000);
  }
  warn('the feed tick was published but not stored yet (is ingestion up?)');
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`demo:reset: ${(error as Error).message}`);
  process.exitCode = 1;
}
