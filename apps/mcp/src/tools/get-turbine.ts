import {
  QueryNotFoundError,
  getTurbine,
  listUnallocated,
  type ReadClient,
} from '@nextera/shared';
import { freshness } from '../staleness.js';
import { businessKey, compactReading, defineTool } from './tool.js';

export const getTurbineTool = defineTool({
  name: 'get_turbine',
  title: 'Get a turbine',
  description:
    'One turbine by its id (e.g. "TURB002"): its farm, location, whether it is commissioned, ' +
    'its latest reading with the alert rules that reading triggered, and its reporting status ' +
    '(ok, stale-15, stale-30, stale-60 or no-data) with minutesSinceLatest. pendingUnallocated ' +
    'lists readings held because they report another farm (see list_unallocated). An id that ' +
    'is not in the fleet but is reporting is pointed to list_unallocated.',
  inputSchema: {
    turbineId: businessKey('The turbine id, e.g. "TURB002".'),
  },
  async run({ db, now }, { turbineId }) {
    const turbine = await getTurbine(db, turbineId).catch(async (error) => {
      throw error instanceof QueryNotFoundError
        ? await notInFleet(db, turbineId, error)
        : error;
    });
    const pending = await listUnallocated(db, { status: 'pending', turbineId });
    return {
      id: turbine.id,
      farm: { id: turbine.farm.id, name: turbine.farm.name },
      latitude: turbine.latitude,
      longitude: turbine.longitude,
      commissioned: turbine.commissioned,
      ...freshness(turbine.latest?.timestamp ?? null, now()),
      latest: turbine.latest && compactReading(turbine.latest),
      pendingUnallocated: pending.map((e) => ({
        id: e.id,
        reportedFarmId: e.reportedFarmId,
        heldCount: e.heldCount,
        lastSeenAt: e.lastSeenAt,
      })),
    };
  },
});

/**
 * The not-found error for a turbine id that isn't in the fleet, pointing to its held readings when
 * it is reporting anyway (an unknown turbine).
 */
async function notInFleet(
  db: ReadClient,
  turbineId: string,
  error: QueryNotFoundError,
): Promise<QueryNotFoundError> {
  const pending = await listUnallocated(db, { status: 'pending', turbineId });
  if (!pending.length) return error;
  const held = pending
    .map((e) => `${e.heldCount} readings reporting farm ${e.reportedFarmId}`)
    .join(', ');
  return new QueryNotFoundError(
    `${error.message}. It is reporting but is not in the fleet: its readings are held ` +
      `(${held}); see list_unallocated with turbineId "${turbineId}"`,
  );
}
