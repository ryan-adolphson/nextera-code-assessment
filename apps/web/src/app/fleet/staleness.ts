import { Telemetry } from './fleet.model';

const MINUTE_MS = 60_000;

/**
 * How long a turbine may go without a reading before it is flagged, mildest first. Turbines report
 * every 5 minutes, so the levels are 3, 6 and 12 missed intervals. A level applies once the age
 * of the latest reading (client clock minus its measurement time) is strictly greater than
 * `afterMs`: exactly 15:00 old is still reporting, 15:00 plus 1 ms is the first level.
 */
export const STALENESS_LEVELS = [
  { level: 'stale-15', afterMs: 15 * MINUTE_MS, label: 'No data in 15 min' },
  { level: 'stale-30', afterMs: 30 * MINUTE_MS, label: 'No data in 30 min' },
  { level: 'stale-60', afterMs: 60 * MINUTE_MS, label: 'No data in 60 min' },
] as const;

export type StaleLevel = (typeof STALENESS_LEVELS)[number]['level'];

/** 'ok' = reporting; 'empty' = has never reported (no latest reading). */
export type Staleness = 'ok' | StaleLevel | 'empty';

/** Freshest first: the order used to pick a farm's level from its turbines (and to sort by status). */
export const STALENESS_ORDER: readonly Staleness[] = [
  'ok',
  ...STALENESS_LEVELS.map((l) => l.level),
  'empty',
];

export const STALENESS_LABELS: Record<Staleness, string> = {
  ok: 'Reporting',
  ...(Object.fromEntries(STALENESS_LEVELS.map((l) => [l.level, l.label])) as Record<
    StaleLevel,
    string
  >),
  empty: 'No readings yet',
};

/**
 * The staleness of a turbine whose latest reading (by measurement time) is `latest`, at client
 * time `now` (epoch ms). A reading dated ahead of the clock (clock skew) counts as reporting.
 */
export function stalenessOf(latest: Telemetry | null | undefined, now: number): Staleness {
  if (!latest) return 'empty';
  const age = now - Date.parse(latest.timestamp);
  let staleness: Staleness = 'ok';
  for (const { level, afterMs } of STALENESS_LEVELS) {
    if (age > afterMs) staleness = level;
  }
  return staleness;
}

/** The freshest of several levels ('empty' when there are none). */
export function freshestStaleness(levels: Staleness[]): Staleness {
  return levels.reduce<Staleness>(
    (best, level) =>
      STALENESS_ORDER.indexOf(level) < STALENESS_ORDER.indexOf(best) ? level : best,
    'empty',
  );
}
