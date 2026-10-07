import { Telemetry } from '../fleet/fleet.model';

/** The longest range the API accepts (GET /api/alerts). */
export const MAX_RANGE_DAYS = 31;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A `datetime-local` value ("2026-01-02T03:25") for an instant, in UTC (the app shows UTC). */
export function toUtcInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** The instant of a UTC `datetime-local` value, or null when empty or invalid. */
export function fromUtcInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The default range: the last 24 hours, `to` rounded up to the next minute so "now" is included. */
export function last24Hours(now: number): { from: number; to: number } {
  const to = Math.ceil(now / MINUTE_MS) * MINUTE_MS;
  return { from: to - DAY_MS, to };
}

/** Why a range cannot be queried, or null when it can (mirrors the API's 400s). */
export function rangeError(from: number | null, to: number | null): string | null {
  if (from === null) return 'Enter a valid start date and time.';
  if (to === null) return 'Enter a valid end date and time.';
  if (to <= from) return 'The end must be after the start.';
  if (to - from > MAX_RANGE_DAYS * DAY_MS) return `Choose at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** A row of the history table: a turbine's group header, or one of its flagged readings. */
export type HistoryRow =
  | {
      kind: 'group';
      turbineId: string;
      farmId: string;
      farmName: string | null;
      /** All of the turbine's flagged readings in the range, not just this page's. */
      count: number;
      /** The group started on an earlier page. */
      continued: boolean;
    }
  | { kind: 'reading'; reading: Telemetry };

/**
 * One page of readings (already grouped by turbine by the API) with a header row before each
 * turbine's readings, repeated (`continued`) when a turbine's readings span pages.
 */
export function groupByTurbine(
  page: readonly Telemetry[],
  all: readonly Telemetry[],
  farmNameOf: (farmId: string) => string | null,
): HistoryRow[] {
  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.turbineId, (counts.get(r.turbineId) ?? 0) + 1);
  const firstIndex = new Map<string, number>();
  all.forEach((r, i) => {
    if (!firstIndex.has(r.turbineId)) firstIndex.set(r.turbineId, i);
  });

  const rows: HistoryRow[] = [];
  page.forEach((reading, i) => {
    if (i === 0 || page[i - 1].turbineId !== reading.turbineId) {
      rows.push({
        kind: 'group',
        turbineId: reading.turbineId,
        farmId: reading.farmId,
        farmName: farmNameOf(reading.farmId),
        count: counts.get(reading.turbineId) ?? 0,
        continued: i === 0 && all.indexOf(reading) > (firstIndex.get(reading.turbineId) ?? 0),
      });
    }
    rows.push({ kind: 'reading', reading });
  });
  return rows;
}
