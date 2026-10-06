import { STALENESS_LABELS, Staleness } from './staleness';

/**
 * The staleness levels that need attention, worst first: silent for over 60, 30, 15 minutes, then
 * turbines that have never reported. These are the only alerts (no other alert types).
 */
export const ALERT_LEVELS = [
  'stale-60',
  'stale-30',
  'stale-15',
  'empty',
] as const satisfies readonly Staleness[];

export type AlertLevel = (typeof ALERT_LEVELS)[number];

export const ALERT_LABELS: Record<AlertLevel, string> = {
  'stale-60': STALENESS_LABELS['stale-60'],
  'stale-30': STALENESS_LABELS['stale-30'],
  'stale-15': STALENESS_LABELS['stale-15'],
  empty: 'Never reported',
};

interface Alertable {
  id: string;
  staleness: Staleness;
  latest: { timestamp: string } | null;
}

/**
 * The turbines needing attention, worst level first (`ALERT_LEVELS`); within a level the one
 * silent longest (oldest measurement time) first, then by turbine id.
 */
export function alertsOf<T extends Alertable>(turbines: readonly T[]): T[] {
  const rank = (t: T) => (ALERT_LEVELS as readonly Staleness[]).indexOf(t.staleness);
  return turbines
    .filter((t) => rank(t) >= 0)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (a.latest?.timestamp ?? '').localeCompare(b.latest?.timestamp ?? '') ||
        a.id.localeCompare(b.id),
    );
}

/** Counts per alert level (every level present, 0 when none). */
export function alertCounts(turbines: readonly Alertable[]): Record<AlertLevel, number> {
  const counts = Object.fromEntries(ALERT_LEVELS.map((l) => [l, 0])) as Record<AlertLevel, number>;
  for (const t of turbines) {
    if (t.staleness in counts) counts[t.staleness as AlertLevel]++;
  }
  return counts;
}

/** A duration as "12 min", "2 h 5 min" (under 2 days) or "3 d 4 h". Negative counts as 0. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}
