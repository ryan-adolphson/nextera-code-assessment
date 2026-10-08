/**
 * Whether a turbine is reporting, with the same thresholds as the web app
 * (apps/web/src/app/fleet/staleness.ts): turbines report every 5 minutes, so the levels are 3, 6
 * and 12 missed intervals. A level applies once the age of the latest reading (clock minus its
 * measurement time) is strictly greater than its threshold: exactly 15:00 old is still `ok`.
 * A reading dated ahead of the clock (clock skew) counts as reporting. The web app calls a turbine
 * without readings `empty`; here it is `no-data`.
 */
export const STALENESS_LEVELS = [
  { status: 'stale-15', afterMs: 15 * 60_000 },
  { status: 'stale-30', afterMs: 30 * 60_000 },
  { status: 'stale-60', afterMs: 60 * 60_000 },
] as const;

export type TurbineStatus =
  'ok' | (typeof STALENESS_LEVELS)[number]['status'] | 'no-data';

export const STATUS_LABELS: Record<TurbineStatus, string> = {
  ok: 'Reporting',
  'stale-15': 'No data in 15 min',
  'stale-30': 'No data in 30 min',
  'stale-60': 'No data in 60 min',
  'no-data': 'No readings yet',
};

export interface Freshness {
  status: TurbineStatus;
  statusLabel: string;
  /** Whole minutes since the latest measurement (0 for a reading ahead of the clock); null if none. */
  minutesSinceLatest: number | null;
}

/** The freshness of a turbine whose latest measurement time is `latest` (ISO), at `nowMs`. */
export function freshness(latest: string | null, nowMs: number): Freshness {
  if (latest === null) {
    return {
      status: 'no-data',
      statusLabel: STATUS_LABELS['no-data'],
      minutesSinceLatest: null,
    };
  }
  const age = nowMs - Date.parse(latest);
  let status: TurbineStatus = 'ok';
  for (const level of STALENESS_LEVELS) {
    if (age > level.afterMs) status = level.status;
  }
  return {
    status,
    statusLabel: STATUS_LABELS[status],
    minutesSinceLatest: Math.max(0, Math.floor(age / 60_000)),
  };
}
