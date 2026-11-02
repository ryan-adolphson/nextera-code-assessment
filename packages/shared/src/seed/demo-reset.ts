import { parseArgs } from 'node:util';
import type { PrismaClient } from '../generated/prisma/client.js';
import { DEMO_TURBINES } from './demo-fleet.js';
import { DEMO_ANOMALIES } from './generate-telemetry.js';

/**
 * The building blocks of `npm run demo:reset` (prisma/demo-reset.ts): the safety checks (target
 * host, confirmation), the delete of the readings, and what the demo's stale turbines should show.
 * The orchestration (seed, weather sync, live feed) lives in the script.
 */

/** The reset's seed window: the last 7 days up to now. */
export const DEMO_RESET_HOURS = 7 * 24;

/** Hosts a reset may target without --allow-remote: this machine. */
export const LOCAL_DATABASE_HOSTS: readonly string[] = [
  'localhost',
  '127.0.0.1',
  '::1',
];
/** The compose Postgres, by service and container name (from inside the compose network). */
export const COMPOSE_DATABASE_HOSTS: readonly string[] = [
  'postgres',
  'nextera-postgres',
];

export const DEMO_RESET_USAGE = [
  'Usage: npm run demo:reset -- [--yes] [--allow-remote] [--no-weather] [--no-feed] [--no-build]',
  '  --yes, -y        skip the confirmation (required when stdin is not a terminal)',
  '  --allow-remote   allow a DATABASE_URL host other than localhost / the compose Postgres',
  '  --no-weather     skip the Open-Meteo weather sync',
  '  --no-feed        skip the feed tick and the compose demo-feed',
  '  --no-build       start the compose demo-feed without rebuilding its image (the ingestion',
  '                   image; rebuilt by default so it runs the current feed code)',
].join('\n');

export interface DemoResetArgs {
  /** Skip the confirmation prompt (required when stdin isn't a terminal). */
  yes: boolean;
  /** Allow a DATABASE_URL host other than localhost / the compose Postgres. */
  allowRemote: boolean;
  /** Sync the farm weather for the window (Open-Meteo). */
  weather: boolean;
  /** Publish a feed tick and start the compose demo feed. */
  feed: boolean;
  /** Rebuild the compose demo-feed image (the ingestion image) before starting it. */
  build: boolean;
}

/** Parses the CLI flags; throws an Error with a message for the user on an unknown one. */
export function parseDemoResetArgs(argv: readonly string[]): DemoResetArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      yes: { type: 'boolean', short: 'y', default: false },
      'allow-remote': { type: 'boolean', default: false },
      'no-weather': { type: 'boolean', default: false },
      'no-feed': { type: 'boolean', default: false },
      'no-build': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    yes: values.yes,
    allowRemote: values['allow-remote'],
    weather: !values['no-weather'],
    feed: !values['no-feed'],
    build: !values['no-build'],
  };
}

/** Where DATABASE_URL points, without the user or password (safe to print). */
export interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
  /** localhost, a loopback address or the compose Postgres. */
  local: boolean;
}

/**
 * The host, port and database of a postgres:// URL. A `?host=` parameter (a socket directory, as
 * for Cloud SQL) wins over the URL's host, like in libpq, and isn't local. Throws on a missing or
 * malformed URL, without echoing it (it holds the password).
 */
export function databaseTarget(url: string | undefined): DatabaseTarget {
  if (!url) throw new Error('DATABASE_URL is not set');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error(
      `DATABASE_URL must be a postgresql:// URL, got ${parsed.protocol}//…`,
    );
  }
  const socket = parsed.searchParams.get('host');
  // URL keeps the brackets of an IPv6 host ([::1]).
  const host = socket || parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const local =
    !socket &&
    [...LOCAL_DATABASE_HOSTS, ...COMPOSE_DATABASE_HOSTS].includes(
      host.toLowerCase(),
    );
  return {
    host,
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    local,
  };
}

export function describeTarget({ host, port, database }: DatabaseTarget) {
  return `${host}:${port}/${database}`;
}

/** Throws unless the target is local or --allow-remote was passed. */
export function assertResetTarget(
  target: DatabaseTarget,
  { allowRemote }: Pick<DemoResetArgs, 'allowRemote'>,
): void {
  if (target.local || allowRemote) return;
  throw new Error(
    `Refusing to reset ${describeTarget(target)}: not localhost or the compose Postgres. ` +
      'Pass --allow-remote if you really mean that database.',
  );
}

/**
 * Whether to go on: yes with --yes; otherwise asks (only on a terminal: without one there is no
 * one to answer, so it refuses). Only "y" or "yes" (any case) goes on.
 */
export async function confirmDemoReset({
  yes,
  interactive,
  ask,
  target,
}: {
  yes: boolean;
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  target: DatabaseTarget;
}): Promise<boolean> {
  if (yes) return true;
  if (!interactive) {
    throw new Error(
      'Refusing to reset without --yes: stdin is not a terminal, so there is no one to confirm.',
    );
  }
  const answer = await ask(
    `Delete every reading, held reading, unallocated entry and weather row in ${describeTarget(target)}? [y/N] `,
  );
  return /^y(es)?$/i.test(answer.trim());
}

export interface ClearedReadings {
  telemetryAlerts: number;
  telemetry: number;
  heldTelemetry: number;
  unallocatedTurbines: number;
  farmWeather: number;
}

/**
 * Deletes the readings and what hangs off them, in one transaction: telemetry_alerts, telemetry,
 * held_telemetry, unallocated_turbines and farm_weather. Farms, turbines, users and alert
 * rules stay (so a moved turbine stays moved). DELETE, not TRUNCATE: it doesn't take an ACCESS
 * EXCLUSIVE lock, so the running services' reads aren't blocked behind it.
 */
export async function clearDemoReadings(
  prisma: PrismaClient,
): Promise<ClearedReadings> {
  return prisma.$transaction(
    async (tx) => {
      // telemetry_alerts first: alert_id is ON DELETE RESTRICT, telemetry_id would CASCADE.
      const telemetryAlerts = await tx.telemetryAlert.deleteMany();
      const telemetry = await tx.telemetry.deleteMany();
      const heldTelemetry = await tx.heldTelemetry.deleteMany();
      const unallocatedTurbines = await tx.unallocatedTurbine.deleteMany();
      const farmWeather = await tx.farmWeather.deleteMany();
      return {
        telemetryAlerts: telemetryAlerts.count,
        telemetry: telemetry.count,
        heldTelemetry: heldTelemetry.count,
        unallocatedTurbines: unallocatedTurbines.count,
        farmWeather: farmWeather.count,
      };
    },
    { timeout: 120_000 },
  );
}

/**
 * The web app's staleness pill for a turbine whose latest reading is `minutes` old
 * (apps/web/src/app/fleet/staleness.ts: strictly more than 15 / 30 / 60 minutes). For the summary
 * only; the web app owns the levels.
 */
export function expectedStalenessPill(minutes: number): string {
  if (minutes > 60) return 'No data in 60 min (red)';
  if (minutes > 30) return 'No data in 30 min (orange)';
  if (minutes > 15) return 'No data in 15 min (yellow)';
  return 'Reporting';
}

export interface DemoStaleTurbine {
  turbineId: string;
  farmId: string;
  /** Minutes the newest reading is behind the seed's end (and the feed's tick). */
  minutesBehind: number;
  /** The live feed keeps it this far behind (lagging), or never publishes it (stopped). */
  kind: 'lagging' | 'stopped';
}

/** The demo turbines that show a staleness pill: the lagging ones, then the stopped ones. */
export function demoStaleTurbines(): DemoStaleTurbine[] {
  const farmOf = new Map(DEMO_TURBINES.map((t) => [t.turbineId, t.farmId]));
  const { lagging, stopped } = DEMO_ANOMALIES;
  return [
    ...lagging.map((l) => ({
      turbineId: l.turbineId,
      farmId: farmOf.get(l.turbineId) ?? '?',
      minutesBehind: l.lagMinutes,
      kind: 'lagging' as const,
    })),
    ...stopped.map((s) => ({
      turbineId: s.turbineId,
      farmId: farmOf.get(s.turbineId) ?? '?',
      minutesBehind: s.offsetMinutes,
      kind: 'stopped' as const,
    })),
  ];
}

/** How many turbines show each pill, in first-seen order (e.g. for the reset's summary). */
export function countByPill(pills: readonly string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const pill of pills) counts.set(pill, (counts.get(pill) ?? 0) + 1);
  return [...counts];
}
