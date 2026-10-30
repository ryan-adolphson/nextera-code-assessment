import { HttpErrorResponse } from '@angular/common/http';
import { utc } from '@date-fns/utc';
import { format } from 'date-fns';

/**
 * Mirrors of the /api/unallocated-turbines responses (packages/shared): turbines whose readings
 * ingestion holds instead of importing, because the turbine id is not in the fleet
 * (`unknown_turbine`) or the reading names another farm than the turbine's (`farm_mismatch`).
 */

/** A farm by id and name. */
export interface FarmRef {
  id: string;
  name: string;
}

export type UnallocatedKind = 'unknown_turbine' | 'farm_mismatch';
export type UnallocatedStatus = 'pending' | 'blocked';

/** A held reading (newest first from the API); `farmId` is the farm the turbine reported. */
export interface HeldReading {
  turbineId: string;
  farmId: string;
  /** Measurement time (ISO, UTC). */
  timestamp: string;
  receivedAt: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
}

/** One (turbine id, reported farm) pair whose readings are held (pending) or dropped (blocked). */
export interface UnallocatedTurbine {
  /** The entry's id (a UUID): the actions' `:id`. */
  id: string;
  turbineId: string;
  kind: UnallocatedKind;
  status: UnallocatedStatus;
  reportedFarmId: string;
  /** The reported farm, or null when no farm has that id. */
  reportedFarm: FarmRef | null;
  /** The turbine's farm for a mismatch; null for an unknown turbine. */
  currentFarm: FarmRef | null;
  /** Server receive times (ISO). */
  firstSeenAt: string;
  lastSeenAt: string;
  heldCount: number;
  /** The newest held reading by measurement time (none once blocked). */
  latest: HeldReading | null;
  blockedAt: string | null;
  /** The email of who blocked it (null if that user is gone). */
  blockedBy: string | null;
}

/** Mirrors TurbineResponse. */
export interface TurbineRef {
  id: string;
  farmId: string;
  latitude: number;
  longitude: number;
  commissioned: boolean;
}

export type ResolutionAction = 'assigned' | 'kept' | 'moved';

/** The answer to assign, keep and move: the turbine and how many held readings were imported. */
export interface UnallocatedResolution {
  action: ResolutionAction;
  id: string;
  turbine: TurbineRef;
  imported: number;
  duplicates: number;
}

/** POST …/:id/assign: the farm, and optionally the turbine's coordinates (both or neither). */
export interface AssignRequest {
  farmId: string;
  latitude?: number;
  longitude?: number;
}

/** SSE: an entry was held, resolved, blocked or unblocked (in any browser, or by ingestion). */
export const UNALLOCATED_CHANGED = 'unallocated-turbine.changed';
/** SSE: a turbine joined or changed farm (after assign, keep or move); payload `{ turbineId }`. */
export const FLEET_CHANGED = 'fleet.changed';

export interface FleetChangedEvent {
  turbineId: string;
}

export const KIND_LABELS: Record<UnallocatedKind, string> = {
  unknown_turbine: 'Unknown turbine',
  farm_mismatch: 'Farm mismatch',
};

/** "Prairie Ridge (FARM01)", or "Unknown farm FARM99" when no farm has the id. */
export function farmLabel(farm: FarmRef | null, id: string): string {
  return farm ? `${farm.name} (${farm.id})` : `Unknown farm ${id}`;
}

/** "12 readings imported" (+ ", 2 already stored"). */
export function importedText({ imported, duplicates }: UnallocatedResolution): string {
  const text = `${imported} ${imported === 1 ? 'reading' : 'readings'} imported`;
  return duplicates ? `${text}, ${duplicates} already stored` : text;
}

/** What an action did (the dialogs close with it; Keep and Unblock run on the page). */
export type UnallocatedOutcome =
  | { kind: 'resolved'; resolution: UnallocatedResolution }
  | { kind: 'blocked' }
  | { kind: 'unblocked' }
  /** The entry was resolved elsewhere first (404): nothing to do, the list reloads. */
  | { kind: 'gone' };

/**
 * The announcement after an action, e.g. "TURB990 assigned to Prairie Ridge (FARM01): 12
 * readings imported." `farmName` names a farm by id (null if unknown).
 */
export function outcomeNotice(
  entry: Pick<UnallocatedTurbine, 'turbineId' | 'reportedFarmId'>,
  outcome: UnallocatedOutcome,
  farmName: (farmId: string) => string | null,
): string {
  const { turbineId, reportedFarmId } = entry;
  switch (outcome.kind) {
    case 'resolved': {
      const { action, turbine } = outcome.resolution;
      const name = farmName(turbine.farmId);
      const farm = name === null ? turbine.farmId : `${name} (${turbine.farmId})`;
      const verb = { assigned: 'assigned to', kept: 'kept in', moved: 'moved to' }[action];
      return `${turbineId} ${verb} ${farm}: ${importedText(outcome.resolution)}.`;
    }
    case 'blocked':
      return `Readings for ${turbineId} from ${reportedFarmId} are now blocked.`;
    case 'unblocked':
      return `${turbineId} from ${reportedFarmId} unblocked: its next reading will show under Pending.`;
    case 'gone':
      return `${turbineId} from ${reportedFarmId} was already resolved elsewhere.`;
  }
}

/**
 * Whether a failed action means the entry is gone (404: resolved, blocked away or unblocked in
 * another browser). Assign also answers 404 for an unknown farm ("Farm FARM09 not found"), which
 * is an error to show, not a resolution.
 */
export function isEntryGone(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse) || error.status !== 404) return false;
  const message: unknown = error.error?.message;
  return !(typeof message === 'string' && /^Farm\b/.test(message));
}

/** A UTC time as the tables show it: "Jan 2, 03:20" (the column headers say UTC). */
export function utcTime(iso: string): string {
  return format(Date.parse(iso), 'MMM d, HH:mm', { in: utc });
}
