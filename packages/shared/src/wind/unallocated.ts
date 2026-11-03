import type {
  HeldTelemetry,
  Prisma,
  UnallocatedTurbine,
} from '../generated/prisma/client.js';
import type {
  UnallocatedKind,
  UnallocatedStatus,
} from '../generated/prisma/enums.js';
import type { TelemetryWithAlerts, TurbineResponse } from './responses.js';
import {
  enabledAlertRules,
  insertTelemetryWithAlerts,
} from './store-telemetry.js';

/**
 * Unallocated turbines: readings for a turbine id that isn't in `turbines` (unknown_turbine), or
 * whose farm_id isn't the turbine's farm (farm_mismatch). Ingestion (Pub/Sub and CSV) holds them in
 * held_telemetry per (turbine id, reported farm) instead of rejecting them, and an owner decides in
 * the API: assign (create the turbine), keep (import under the turbine's farm), move (move the
 * turbine and its history to the reported farm) or block (drop them until unblocked).
 *
 * Concurrency: every writer of these tables (ingestion's hold, the API's actions) runs in one
 * transaction that first takes a per-turbine-id advisory lock (`lockTurbineIds`), then locks the
 * entry row (`FOR UPDATE`). Row locks alone can't close every race (a row that doesn't exist yet or
 * was just deleted can't be locked): with the advisory lock, a reading classified as unknown can't
 * be held after an assign of that turbine committed, and an assign can't miss a reading held while
 * it imports.
 */

/** Held readings are kept for at most 7 days before the newest one of their entry. */
export const HELD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * At most this many pending entries. A reading for a NEW pair beyond it is rejected as before
 * (400 → dead-letter topic), so a flood of junk ids can't grow the table without limit. A soft cap:
 * concurrent first readings of different new pairs may pass it by a few.
 */
export const MAX_PENDING_UNALLOCATED = 500;

/** `unallocated-turbine.changed` for further held readings: at most once per entry per minute. */
export const UNALLOCATED_EVENT_INTERVAL_MS = 60_000;

/**
 * SSE event: an unallocated entry was created or got readings ('held'), or an owner resolved,
 * blocked or unblocked it. Published after the commit. Ids and actions only (every signed-in user
 * receives the stream).
 */
export const UNALLOCATED_CHANGED = 'unallocated-turbine.changed';

/**
 * SSE event: the fleet's turbines changed (a turbine was created by an assign, moved to another
 * farm, or its commissioned flag changed), so clients reload the farm list. Published after the
 * commit.
 */
export const FLEET_CHANGED = 'fleet.changed';

export type UnallocatedAction =
  'held' | 'assigned' | 'kept' | 'moved' | 'blocked' | 'unblocked';

/** Payload of `unallocated-turbine.changed`. `id` is the entry's id. */
export interface UnallocatedChangedEvent {
  action: UnallocatedAction;
  id: string;
  turbineId: string;
}

/** Payload of `fleet.changed`. */
export interface FleetChangedEvent {
  turbineId: string;
}

/** A reading as ingestion stores it (the telemetry columns). */
export interface TelemetryRowInput {
  turbineId: string;
  farmId: string;
  timestamp: Date;
  receivedAt: Date;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
}

/**
 * Where a reading goes: telemetry ('known'), nowhere ('blocked': its pair is blocked), or held as
 * an unknown turbine or a farm mismatch.
 */
export type ReadingClass = 'known' | 'blocked' | UnallocatedKind;

const pairKey = (turbineId: string, farmId: string) =>
  `${turbineId}\u0000${farmId}`;

const distinct = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * Per-turbine-id advisory locks, held until the transaction ends. Taken in key order, so two
 * transactions locking several ids can't deadlock each other.
 */
export async function lockTurbineIds(
  tx: Prisma.TransactionClient,
  turbineIds: readonly string[],
): Promise<void> {
  if (!turbineIds.length) return;
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(keys.k)
    FROM (
      SELECT DISTINCT hashtextextended('unallocated:' || ids.id, 0) AS k
      FROM unnest(${distinct(turbineIds)}::text[]) AS ids(id)
      ORDER BY k
    ) keys`;
}

async function turbineFarms(
  tx: Prisma.TransactionClient,
  turbineIds: string[],
): Promise<Map<string, string>> {
  const turbines = await tx.turbine.findMany({
    where: { turbineId: { in: turbineIds } },
    select: { turbineId: true, farmId: true },
  });
  return new Map(turbines.map((t) => [t.turbineId, t.farmId]));
}

/**
 * Classifies each reading (same order as `readings`). Run it inside the write transaction: for the
 * readings that aren't plainly known it takes the turbine ids' advisory locks and classifies them
 * again, so the result can't be outdated by an assign, move or block committing meanwhile. Known
 * readings take no lock (the telemetry foreign key catches a concurrent move: the write fails and
 * is retried).
 */
export async function classifyReadings(
  tx: Prisma.TransactionClient,
  readings: readonly { turbineId: string; farmId: string }[],
): Promise<ReadingClass[]> {
  let farmOf = await turbineFarms(
    tx,
    distinct(readings.map((r) => r.turbineId)),
  );
  const suspects = distinct(
    readings
      .filter((r) => farmOf.get(r.turbineId) !== r.farmId)
      .map((r) => r.turbineId),
  );
  if (!suspects.length) return readings.map(() => 'known');

  await lockTurbineIds(tx, suspects);
  farmOf = new Map([...farmOf, ...(await turbineFarms(tx, suspects))]);
  const blocked = await tx.unallocatedTurbine.findMany({
    where: { status: 'blocked', turbineId: { in: suspects } },
    select: { turbineId: true, reportedFarmId: true },
  });
  const blockedPairs = new Set(
    blocked.map((b) => pairKey(b.turbineId, b.reportedFarmId)),
  );

  return readings.map((r) => {
    const farmId = farmOf.get(r.turbineId);
    if (farmId === r.farmId) return 'known';
    if (blockedPairs.has(pairKey(r.turbineId, r.farmId))) return 'blocked';
    return farmId ? 'farm_mismatch' : 'unknown_turbine';
  });
}

/** New pairs that would pass MAX_PENDING_UNALLOCATED; their readings are rejected (400). */
export class UnallocatedCapError extends Error {
  override readonly name = 'UnallocatedCapError';

  constructor(
    readonly pairs: readonly { turbineId: string; farmId: string }[],
  ) {
    super(
      `Too many pending unallocated turbines (${MAX_PENDING_UNALLOCATED}): readings for ${pairs
        .map((p) => `${p.turbineId} on ${p.farmId}`)
        .join(', ')} are rejected until pending ones are assigned or blocked`,
    );
  }

  /** The message for one pair (CSV line errors). */
  static messageFor(turbineId: string, farmId: string): string {
    return `Too many pending unallocated turbines (${MAX_PENDING_UNALLOCATED}): readings for ${turbineId} on ${farmId} are rejected until pending ones are assigned or blocked`;
  }
}

/** One entry `holdReadings` wrote to. */
export interface HeldEntry {
  id: string;
  turbineId: string;
  reportedFarmId: string;
  kind: UnallocatedKind;
  /** The entry was created by this call. */
  created: boolean;
  /** New held readings (duplicates of held ones are skipped). */
  held: number;
  /**
   * Whether to publish `unallocated-turbine.changed` ('held') after the commit: on creation, else
   * at most once per UNALLOCATED_EVENT_INTERVAL_MS per entry (the first new reading in a minute).
   */
  notify: boolean;
}

/** A reading `classifyReadings` found unknown or mismatched. */
export type HoldableReading = TelemetryRowInput & { kind: UnallocatedKind };

const HOLD_BATCH_SIZE = 1000;

/**
 * Holds readings of unknown or mismatched pairs (from `classifyReadings`, same transaction): per
 * (turbine id, reported farm) it locks the entry (`FOR UPDATE`), creates it (pending, within
 * MAX_PENDING_UNALLOCATED) or updates `last_seen_at` and `kind`, inserts the readings into
 * held_telemetry (idempotent on (entry, timestamp)) and prunes the entry's readings older than its
 * newest minus HELD_RETENTION_MS. Throws `UnallocatedCapError` (after checking every pair) if a new
 * pair is over the cap: the caller rejects the readings and the transaction rolls back.
 */
export async function holdReadings(
  tx: Prisma.TransactionClient,
  readings: readonly HoldableReading[],
  now: Date = new Date(),
): Promise<HeldEntry[]> {
  const groups = new Map<string, HoldableReading[]>();
  for (const reading of readings) {
    const key = pairKey(reading.turbineId, reading.farmId);
    const group = groups.get(key);
    if (group) group.push(reading);
    else groups.set(key, [reading]);
  }
  // Re-entrant: a no-op wait when classifyReadings already took them in this transaction.
  await lockTurbineIds(
    tx,
    readings.map((r) => r.turbineId),
  );

  let pending: number | undefined;
  const overCap: { turbineId: string; farmId: string }[] = [];
  const entries: HeldEntry[] = [];
  for (const rows of groups.values()) {
    const { turbineId, farmId, kind } = rows[0];
    const [existing] = await tx.$queryRaw<
      { id: string; status: UnallocatedStatus; last_seen_at: Date }[]
    >`
      SELECT id::text AS id, status::text AS status, last_seen_at
      FROM unallocated_turbines
      WHERE turbine_id = ${turbineId} AND reported_farm_id = ${farmId}
      FOR UPDATE`;
    if (existing?.status === 'blocked') {
      throw new Error(
        `${turbineId} on ${farmId} is blocked: classify readings in the same transaction first`,
      );
    }

    let id: string;
    if (existing) {
      id = existing.id;
      await tx.unallocatedTurbine.update({
        where: { id },
        data: { lastSeenAt: now, kind },
      });
    } else {
      pending ??= await tx.unallocatedTurbine.count({
        where: { status: 'pending' },
      });
      if (pending >= MAX_PENDING_UNALLOCATED) {
        overCap.push({ turbineId, farmId });
        continue;
      }
      pending++;
      ({ id } = await tx.unallocatedTurbine.create({
        data: {
          turbineId,
          reportedFarmId: farmId,
          kind,
          firstSeenAt: now,
          lastSeenAt: now,
        },
        select: { id: true },
      }));
    }

    let held = 0;
    for (let i = 0; i < rows.length; i += HOLD_BATCH_SIZE) {
      const { count } = await tx.heldTelemetry.createMany({
        data: rows
          .slice(i, i + HOLD_BATCH_SIZE)
          .map(({ kind: _kind, ...row }) => ({ ...row, unallocatedId: id })),
        skipDuplicates: true,
      });
      held += count;
    }
    if (held) {
      await tx.$executeRaw`
        DELETE FROM held_telemetry
        WHERE unallocated_id = ${id}::uuid
          AND timestamp < (
            SELECT max(timestamp) FROM held_telemetry WHERE unallocated_id = ${id}::uuid
          ) - make_interval(secs => ${HELD_RETENTION_MS / 1000}::double precision)`;
    }

    const bucket = (date: Date) =>
      Math.floor(date.getTime() / UNALLOCATED_EVENT_INTERVAL_MS);
    entries.push({
      id,
      turbineId,
      reportedFarmId: farmId,
      kind,
      created: !existing,
      held,
      notify:
        !existing ||
        (held > 0 && bucket(existing.last_seen_at) !== bucket(now)),
    });
  }

  if (overCap.length) throw new UnallocatedCapError(overCap);
  return entries;
}

/**
 * Locks an entry for an action (advisory lock on its turbine id, then `SELECT … FOR UPDATE`) and
 * returns it as it is now, or null if it doesn't exist (or was deleted by an action that committed
 * while this one waited). Call it first in the action's transaction.
 */
export async function lockUnallocated(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<UnallocatedTurbine | null> {
  const found = await tx.unallocatedTurbine.findUnique({
    where: { id },
    select: { turbineId: true },
  });
  if (!found) return null;
  await lockTurbineIds(tx, [found.turbineId]);
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id FROM unallocated_turbines WHERE id = ${id}::uuid FOR UPDATE`;
  if (!locked.length) return null;
  return tx.unallocatedTurbine.findUnique({ where: { id } });
}

/**
 * What "blocked" means, in one place (the API's block action and the demo seed): status blocked,
 * when and by whom (a user id, or null), and no held readings (ingestion drops the pair's readings
 * from now on). Run it in the action's transaction, after `lockUnallocated` checked it is pending.
 */
export async function blockUnallocated(
  tx: Prisma.TransactionClient,
  unallocatedId: string,
  { blockedAt, blockedById }: { blockedAt: Date; blockedById: string | null },
): Promise<void> {
  await tx.unallocatedTurbine.update({
    where: { id: unallocatedId },
    data: { status: 'blocked', blockedAt, blockedById },
  });
  await tx.heldTelemetry.deleteMany({ where: { unallocatedId } });
}

export interface ImportResult {
  /** Readings now in telemetry (held readings already stored there are skipped). */
  imported: number;
  /** Held readings skipped because telemetry already has the turbine at that time. */
  duplicates: number;
  /** The newest imported reading with its alerts (for `telemetry.received`), or null. */
  newest: TelemetryWithAlerts | null;
}

/**
 * Moves an entry's held readings into telemetry under `farmId` (the turbine's farm, which must
 * exist by now), evaluating the enabled alert rules like ingestion, then deletes the entry (its
 * held readings cascade). Run it in the action's transaction, after `lockUnallocated`.
 */
export async function importHeld(
  tx: Prisma.TransactionClient,
  unallocatedId: string,
  farmId: string,
): Promise<ImportResult> {
  const held = await tx.heldTelemetry.findMany({
    where: { unallocatedId },
    orderBy: { timestamp: 'asc' },
  });
  const rows = held.map((h) => ({
    turbineId: h.turbineId,
    farmId,
    timestamp: h.timestamp,
    receivedAt: h.receivedAt,
    powerOutputKw: h.powerOutputKw,
    windSpeedMs: h.windSpeedMs,
    rotorRpm: h.rotorRpm,
    bladePitchDeg: h.bladePitchDeg,
    gearboxTempC: h.gearboxTempC,
  }));

  const imported: TelemetryWithAlerts[] = [];
  if (rows.length) {
    const rules = await enabledAlertRules(tx);
    for (let i = 0; i < rows.length; i += HOLD_BATCH_SIZE) {
      imported.push(
        ...(await insertTelemetryWithAlerts(
          tx,
          rows.slice(i, i + HOLD_BATCH_SIZE),
          rules,
        )),
      );
    }
  }
  await tx.unallocatedTurbine.delete({ where: { id: unallocatedId } });

  const newest = imported.reduce<TelemetryWithAlerts | null>(
    (latest, r) => (!latest || r.timestamp > latest.timestamp ? r : latest),
    null,
  );
  return {
    imported: imported.length,
    duplicates: rows.length - imported.length,
    newest,
  };
}

// ---------------------------------------------------------------------------------------------
// Responses (API)

/** A held reading as reported (farmId is the reported farm). No internal ids. */
export interface HeldReadingResponse {
  turbineId: string;
  farmId: string;
  /** When the turbine measured the values (ISO, UTC). */
  timestamp: string;
  /** When the platform received the reading (ISO, UTC). */
  receivedAt: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
}

/** A farm by id and name. */
export interface FarmRef {
  id: string;
  name: string;
}

/** GET /api/unallocated-turbines: one (turbine id, reported farm) entry. */
export interface UnallocatedTurbineResponse {
  /** The entry's id (UUID), for the actions. */
  id: string;
  turbineId: string;
  /**
   * As things are now: unknown_turbine while the turbine id isn't in the fleet, else
   * farm_mismatch.
   */
  kind: UnallocatedKind;
  status: UnallocatedStatus;
  /** The farm id the readings report. */
  reportedFarmId: string;
  /** That farm, or null if no farm has that id. */
  reportedFarm: FarmRef | null;
  /** farm_mismatch: the turbine's farm now; null for an unknown turbine. */
  currentFarm: FarmRef | null;
  /** When the platform received the first / latest reading for this pair (ISO, UTC). */
  firstSeenAt: string;
  lastSeenAt: string;
  /** Held readings (0 once blocked). */
  heldCount: number;
  /** The newest held reading by measurement time, or null. */
  latest: HeldReadingResponse | null;
  /** Blocked entries: when, and by whom (email; null if that user was deleted). */
  blockedAt: string | null;
  blockedBy: string | null;
}

/** What `toUnallocatedResponse` needs: the entry and what the list query joined to it. */
export interface UnallocatedListRow {
  entry: UnallocatedTurbine & { blockedBy: { email: string } | null };
  heldCount: number;
  latest: HeldTelemetry | null;
  reportedFarm: FarmRef | null;
  currentFarm: FarmRef | null;
}

export function toHeldReadingResponse(row: HeldTelemetry): HeldReadingResponse {
  return {
    turbineId: row.turbineId,
    farmId: row.farmId,
    timestamp: row.timestamp.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    powerOutputKw: row.powerOutputKw,
    windSpeedMs: row.windSpeedMs,
    rotorRpm: row.rotorRpm,
    bladePitchDeg: row.bladePitchDeg,
    gearboxTempC: row.gearboxTempC,
  };
}

export function toUnallocatedResponse({
  entry,
  heldCount,
  latest,
  reportedFarm,
  currentFarm,
}: UnallocatedListRow): UnallocatedTurbineResponse {
  return {
    id: entry.id,
    turbineId: entry.turbineId,
    kind: currentFarm ? 'farm_mismatch' : 'unknown_turbine',
    status: entry.status,
    reportedFarmId: entry.reportedFarmId,
    reportedFarm,
    currentFarm,
    firstSeenAt: entry.firstSeenAt.toISOString(),
    lastSeenAt: entry.lastSeenAt.toISOString(),
    heldCount,
    latest: latest ? toHeldReadingResponse(latest) : null,
    blockedAt: entry.blockedAt?.toISOString() ?? null,
    blockedBy: entry.blockedBy?.email ?? null,
  };
}

/**
 * POST /api/unallocated-turbines/:id/assign | keep | move: the entry is resolved (deleted) and its
 * held readings are in telemetry under `turbine.farmId`.
 */
export interface UnallocatedResolutionResponse {
  action: 'assigned' | 'kept' | 'moved';
  /** The resolved entry's id (it no longer exists). */
  id: string;
  /** The turbine as it is now (created by an assign, on its new farm after a move). */
  turbine: TurbineResponse;
  /** Held readings now in telemetry. */
  imported: number;
  /** Held readings skipped because telemetry already had the turbine at that time. */
  duplicates: number;
}
