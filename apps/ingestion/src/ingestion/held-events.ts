import type { Logger } from '@nestjs/common';
import {
  UNALLOCATED_CHANGED,
  type EventStore,
  type HeldEntry,
  type UnallocatedChangedEvent,
} from '@nextera/shared';

/**
 * unallocated-turbine.changed ('held') for the entries that were created or, at most once a
 * minute, got new readings (HeldEntry.notify). After the commit, best-effort: a Redis failure is
 * logged, never thrown.
 */
export async function publishHeld(
  events: EventStore,
  logger: Logger,
  entries: HeldEntry[],
): Promise<void> {
  for (const entry of entries) {
    logger.log(
      `Held ${entry.held} reading(s) of ${entry.turbineId} reporting ${entry.reportedFarmId} (${entry.kind}${entry.created ? ', new' : ''})`,
    );
  }
  try {
    for (const entry of entries.filter((e) => e.notify)) {
      const event: UnallocatedChangedEvent = {
        action: 'held',
        id: entry.id,
        turbineId: entry.turbineId,
      };
      await events.publish(UNALLOCATED_CHANGED, event);
    }
  } catch (error) {
    logger.warn(
      `Readings held, but live update failed: ${(error as Error).message}`,
    );
  }
}
