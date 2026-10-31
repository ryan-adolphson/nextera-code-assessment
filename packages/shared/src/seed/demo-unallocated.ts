import type { PrismaClient } from '../generated/prisma/client.js';
import type {
  UnallocatedKind,
  UnallocatedStatus,
} from '../generated/prisma/enums.js';
import { normalizeEmail } from '../auth/passwords.js';
import {
  blockUnallocated,
  classifyReadings,
  holdReadings,
  type TelemetryRowInput,
} from '../wind/unallocated.js';
import { DEMO_SEED } from './demo-fleet.js';
import {
  DEMO_ANOMALIES,
  floorToTelemetryStep,
  generateTelemetry,
} from './generate-telemetry.js';

/**
 * One unallocated (turbine id, reported farm) pair of the demo seed, for the Unallocated tab.
 * Its readings are generated like the demo telemetry (DEMO_SEED, as reported: farm_id is the
 * reported farm): `hours` of them, the newest `endOffsetMinutes` before the seed's end. A blocked
 * entry's readings were held first, then the entry was blocked (which deleted them) `blocked`
 * minutes before the end, by a seed user.
 */
export interface DemoUnallocatedEntry {
  turbineId: string;
  reportedFarmId: string;
  status: UnallocatedStatus;
  hours: number;
  endOffsetMinutes: number;
  /** Blocked entries only: when (minutes before the seed end) and by whom (a SEED_USERS email). */
  blocked?: { offsetMinutes: number; byEmail: string };
}

/**
 * The demo seed's unallocated entries. Turbine ids are either outside DEMO_TURBINES (unknown
 * turbines) or demo turbines reporting another farm than their own (farm mismatches); FARM99 is
 * not a farm. Pending ones end at the seed's end; TURB099 on FARM01 is the pair the live demo feed
 * publishes (DEMO_ANOMALIES.unallocated), so the feed continues its held readings.
 */
export const DEMO_UNALLOCATED: readonly DemoUnallocatedEntry[] = [
  // Unknown turbine, existing farm: Assign preselects FARM01.
  {
    turbineId: DEMO_ANOMALIES.unallocated.turbineId,
    reportedFarmId: DEMO_ANOMALIES.unallocated.farmId,
    status: 'pending',
    hours: 6,
    endOffsetMinutes: 0,
  },
  // Unknown turbine, unknown farm: "Unknown farm FARM99", Assign has no preselected farm.
  {
    turbineId: 'TURB098',
    reportedFarmId: 'FARM99',
    status: 'pending',
    hours: 3,
    endOffsetMinutes: 0,
  },
  // Farm mismatch, the reported farm exists: TURB003 is on FARM01 (Keep and Move).
  {
    turbineId: 'TURB003',
    reportedFarmId: 'FARM02',
    status: 'pending',
    hours: 2,
    endOffsetMinutes: 0,
  },
  // Farm mismatch, the reported farm doesn't exist: TURB004 is on FARM01 (Keep; Move disabled).
  {
    turbineId: 'TURB004',
    reportedFarmId: 'FARM99',
    status: 'pending',
    hours: 1,
    endOffsetMinutes: 0,
  },
  // Blocked unknown turbine, a day before the end, by the admin.
  {
    turbineId: 'TURB097',
    reportedFarmId: 'FARM05',
    status: 'blocked',
    hours: 2,
    endOffsetMinutes: 24 * 60 + 5,
    blocked: { offsetMinutes: 24 * 60, byEmail: 'admin@nextera.local' },
  },
  // Blocked farm mismatch: TURB005 is on FARM02. Blocked 12 h before the end by the owner.
  {
    turbineId: 'TURB005',
    reportedFarmId: 'FARM03',
    status: 'blocked',
    hours: 1,
    endOffsetMinutes: 12 * 60 + 5,
    blocked: { offsetMinutes: 12 * 60, byEmail: 'owner@nextera.local' },
  },
];

const MINUTE_MS = 60_000;

/**
 * The readings of a demo entry as ingestion would hold them (oldest first), ending
 * `endOffsetMinutes` before `end` (floored to 5 minutes). Deterministic.
 */
export function demoUnallocatedReadings(
  entry: DemoUnallocatedEntry,
  end: Date,
): TelemetryRowInput[] {
  const newest =
    floorToTelemetryStep(end).getTime() - entry.endOffsetMinutes * MINUTE_MS;
  return generateTelemetry({
    turbines: [{ turbineId: entry.turbineId, farmId: entry.reportedFarmId }],
    end: newest,
    hours: entry.hours,
    seed: DEMO_SEED,
  }).map((r) => ({
    turbineId: r.turbine_id,
    farmId: r.farm_id,
    timestamp: new Date(r.timestamp),
    receivedAt: new Date(r.received_at),
    powerOutputKw: r.power_output_kw,
    windSpeedMs: r.wind_speed_ms,
    rotorRpm: r.rotor_rpm,
    bladePitchDeg: r.blade_pitch_deg,
    gearboxTempC: r.gearbox_temp_c,
  }));
}

/**
 * What the seed did with a DEMO_UNALLOCATED entry:
 * - `created`: the entry didn't exist; it was created (pending, or held then blocked);
 * - `updated`: a pending entry existed; its held readings were topped up to the seed's end;
 * - `unchanged`: an entry exists and the seed leaves it as it is (a blocked one, or a pending one
 *   where the plan says blocked: the seed never blocks or unblocks what a user may have decided);
 * - `resolved`: the turbine is on the reported farm now (assigned there, or moved there), so the
 *   pair's readings would be stored as telemetry: no entry is created.
 */
export type DemoUnallocatedOutcome =
  'created' | 'updated' | 'unchanged' | 'resolved';

export interface DemoUnallocatedResult {
  turbineId: string;
  reportedFarmId: string;
  outcome: DemoUnallocatedOutcome;
  /** The entry's kind as classified now (null when resolved). */
  kind: UnallocatedKind | null;
  /** The entry's status now (null when resolved). */
  status: UnallocatedStatus | null;
  /** Held readings added by this run (0 for blocked entries). */
  held: number;
}

/**
 * Seeds DEMO_UNALLOCATED the way ingestion and the API would have created them, one transaction
 * per entry: `classifyReadings` decides (as it does for a real reading) whether the pair is still
 * unallocated and its kind, `holdReadings` holds the readings (first_seen_at = the first reading's
 * receive time, last_seen_at = the newest's), and `blockUnallocated` blocks the planned blocked
 * ones. Idempotent: a re-run tops up pending entries to the new end (never moving last_seen_at
 * back), leaves blocked ones alone and skips pairs that are resolved. Since an assign, keep, move
 * or unblock deletes its entry, a re-run can't tell those apart from "never seeded": a kept pair
 * (or a TURB098 assigned to an existing farm, now a farm mismatch with FARM99) is created again,
 * like the turbine's next real reading would; an unblocked pair is blocked again. Publishes no
 * events.
 */
export async function seedDemoUnallocated(
  prisma: PrismaClient,
  end: Date,
): Promise<DemoUnallocatedResult[]> {
  const users = await prisma.user.findMany({
    where: {
      email: {
        in: DEMO_UNALLOCATED.flatMap((e) =>
          e.blocked ? [normalizeEmail(e.blocked.byEmail)] : [],
        ),
      },
    },
    select: { id: true, email: true },
  });
  const userId = new Map(users.map((u) => [u.email, u.id]));

  const results: DemoUnallocatedResult[] = [];
  for (const plan of DEMO_UNALLOCATED) {
    const readings = demoUnallocatedReadings(plan, end);
    results.push(
      await prisma.$transaction(
        async (tx): Promise<DemoUnallocatedResult> => {
          const pair = {
            turbineId: plan.turbineId,
            reportedFarmId: plan.reportedFarmId,
          };
          // Locks the turbine id (advisory) unless the pair is plainly known.
          const [kind] = await classifyReadings(tx, [
            { turbineId: plan.turbineId, farmId: plan.reportedFarmId },
          ]);
          if (kind === 'known') {
            return {
              ...pair,
              outcome: 'resolved',
              kind: null,
              status: null,
              held: 0,
            };
          }
          const existing = await tx.unallocatedTurbine.findUnique({
            where: { turbineId_reportedFarmId: pair },
          });
          if (kind === 'blocked' || (existing && plan.status === 'blocked')) {
            return {
              ...pair,
              outcome: 'unchanged',
              kind: existing?.kind ?? null,
              status: existing?.status ?? null,
              held: 0,
            };
          }

          const holdable = readings.map((r) => ({ ...r, kind }));
          const newest = holdable[holdable.length - 1].receivedAt;
          let held = 0;
          let rest = holdable;
          let id: string;
          if (existing) {
            id = existing.id;
          } else {
            // The first reading creates the entry at its receive time (first_seen_at).
            const [first] = await holdReadings(
              tx,
              holdable.slice(0, 1),
              holdable[0].receivedAt,
            );
            ({ id } = first);
            held += first.held;
            rest = holdable.slice(1);
          }
          if (rest.length) {
            // last_seen_at = the newest reading's receive time, never earlier than it was.
            const lastSeen =
              existing && existing.lastSeenAt > newest
                ? existing.lastSeenAt
                : newest;
            const [entry] = await holdReadings(tx, rest, lastSeen);
            held += entry.held;
          }

          if (plan.blocked) {
            await blockUnallocated(tx, id, {
              blockedAt: new Date(
                floorToTelemetryStep(end).getTime() -
                  plan.blocked.offsetMinutes * MINUTE_MS,
              ),
              blockedById:
                userId.get(normalizeEmail(plan.blocked.byEmail)) ?? null,
            });
          }
          return {
            ...pair,
            outcome: existing ? 'updated' : 'created',
            kind,
            status: plan.blocked ? 'blocked' : 'pending',
            held: plan.blocked ? 0 : held,
          };
        },
        { timeout: 60_000 },
      ),
    );
  }
  return results;
}
