import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EventStore,
  FLEET_CHANGED,
  PrismaService,
  TELEMETRY_RECEIVED,
  UNALLOCATED_CHANGED,
  getUnallocated,
  heldReadings,
  importHeld,
  listUnallocated,
  lockUnallocated,
  toTelemetryResponse,
  toTurbineResponse,
  type FleetChangedEvent,
  type HeldReadingResponse,
  type ImportResult,
  type Prisma,
  type Turbine,
  type UnallocatedChangedEvent,
  type UnallocatedResolutionResponse,
  type UnallocatedStatus,
  type UnallocatedTurbine,
  type UnallocatedTurbineResponse,
} from '@nextera/shared';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { httpQuery } from '../common/query-errors.js';
import { AssignUnallocatedDto } from './dto/unallocated.dto.js';

type Resolution = UnallocatedResolutionResponse['action'];

/** An import of up to 7 days of readings per entry; well within this. */
const ACTION_TIMEOUT_MS = 60_000;

/**
 * The owner's decisions on unallocated turbines. Each action is one transaction that first locks
 * the entry (`lockUnallocated`: the turbine id's advisory lock, then `FOR UPDATE`), so it can't
 * interleave with ingestion holding readings for it or with another action on it; the loser of two
 * concurrent actions sees the entry as it is after the winner (gone: 404, blocked: 409). Events are
 * published after the commit, best-effort.
 */
@Injectable()
export class UnallocatedTurbinesService {
  private readonly logger = new Logger(UnallocatedTurbinesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStore,
  ) {}

  list(status: UnallocatedStatus): Promise<UnallocatedTurbineResponse[]> {
    return listUnallocated(this.prisma, { status });
  }

  readings(id: string, limit: number): Promise<HeldReadingResponse[]> {
    return httpQuery(heldReadings(this.prisma, id, limit));
  }

  /**
   * An unknown turbine: creates it on `farmId` (not commissioned; coordinates default to the
   * farm's) and imports the held readings under that farm. 404 for an unknown farm, 409 if the
   * turbine id is in the fleet by now (keep or move instead).
   */
  async assign(
    id: string,
    { farmId, latitude, longitude }: AssignUnallocatedDto,
  ): Promise<UnallocatedResolutionResponse> {
    if ((latitude === undefined) !== (longitude === undefined)) {
      throw new BadRequestException(
        'Provide both latitude and longitude, or neither',
      );
    }
    return this.resolve(id, 'assigned', async (tx, entry) => {
      const existing = await this.turbineOf(tx, entry);
      if (existing) {
        throw new ConflictException(
          `Turbine ${entry.turbineId} already exists on ${existing.farmId}: keep or move it instead`,
        );
      }
      const farm = await tx.farm.findUnique({ where: { id: farmId } });
      if (!farm) throw new NotFoundException(`Farm ${farmId} not found`);

      const turbine = await tx.turbine.create({
        data: {
          turbineId: entry.turbineId,
          farmId: farm.id,
          latitude: latitude ?? farm.latitude,
          longitude: longitude ?? farm.longitude,
        },
      });
      // Other farms' entries for this turbine id are farm mismatches from now on.
      await tx.unallocatedTurbine.updateMany({
        where: { turbineId: entry.turbineId, id: { not: entry.id } },
        data: { kind: 'farm_mismatch' },
      });
      return { turbine, imported: await importHeld(tx, entry.id, farm.id) };
    });
  }

  /**
   * A farm mismatch, the device's farm setting was wrong: imports the held readings under the
   * turbine's own farm. 409 for an unknown turbine (assign it instead).
   */
  keep(id: string): Promise<UnallocatedResolutionResponse> {
    return this.resolve(id, 'kept', async (tx, entry) => {
      const turbine = await this.knownTurbine(tx, entry);
      return {
        turbine,
        imported: await importHeld(tx, entry.id, turbine.farmId),
      };
    });
  }

  /**
   * A farm mismatch, the turbine really is on the reported farm: moves the turbine there, and its
   * history with it (telemetry_turbine_id_farm_id_fkey is ON UPDATE CASCADE, so updating
   * turbines.farm_id rewrites telemetry.farm_id in the same transaction), then imports the held
   * readings. 409 for an unknown turbine, or if the reported farm doesn't exist.
   */
  move(id: string): Promise<UnallocatedResolutionResponse> {
    return this.resolve(id, 'moved', async (tx, entry) => {
      const current = await this.knownTurbine(tx, entry);
      const farm = await tx.farm.findUnique({
        where: { id: entry.reportedFarmId },
        select: { id: true },
      });
      if (!farm) {
        throw new ConflictException(
          `Farm ${entry.reportedFarmId} does not exist: keep ${entry.turbineId} in ${current.farmId} or block it`,
        );
      }
      const turbine =
        current.farmId === farm.id
          ? current
          : await tx.turbine.update({
              where: { turbineId: entry.turbineId },
              data: { farmId: farm.id },
            });
      return { turbine, imported: await importHeld(tx, entry.id, farm.id) };
    });
  }

  /**
   * Drops this (turbine, reported farm)'s readings from now on and deletes the held ones. Records
   * who blocked it and when. 409 if it is blocked already.
   */
  async block(
    id: string,
    user: AuthenticatedUser,
  ): Promise<UnallocatedTurbineResponse> {
    const blocked = await this.prisma.$transaction(async (tx) => {
      const entry = await this.lockPending(tx, id);
      await tx.unallocatedTurbine.update({
        where: { id },
        data: {
          status: 'blocked',
          blockedAt: new Date(),
          blockedById: user.id,
        },
      });
      await tx.heldTelemetry.deleteMany({ where: { unallocatedId: id } });
      return { entry, response: await getUnallocated(tx, id) };
    });
    await this.publish(UNALLOCATED_CHANGED, changed('blocked', blocked.entry));
    return blocked.response;
  }

  /** Deletes a blocked entry: the pair's next reading creates a new pending one. 409 if pending. */
  async unblock(id: string): Promise<void> {
    const entry = await this.prisma.$transaction(async (tx) => {
      const entry = await this.lock(tx, id);
      if (entry.status !== 'blocked') {
        throw new ConflictException(`${pairOf(entry)} is not blocked`);
      }
      await tx.unallocatedTurbine.delete({ where: { id } });
      return entry;
    });
    await this.publish(UNALLOCATED_CHANGED, changed('unblocked', entry));
  }

  /** Runs an assign, keep or move on a locked pending entry, then publishes its events. */
  private async resolve(
    id: string,
    action: Resolution,
    run: (
      tx: Prisma.TransactionClient,
      entry: UnallocatedTurbine,
    ) => Promise<{ turbine: Turbine; imported: ImportResult }>,
  ): Promise<UnallocatedResolutionResponse> {
    const { entry, turbine, imported } = await this.prisma.$transaction(
      async (tx) => {
        const entry = await this.lockPending(tx, id);
        return { entry, ...(await run(tx, entry)) };
      },
      { timeout: ACTION_TIMEOUT_MS },
    );

    await this.publish(UNALLOCATED_CHANGED, changed(action, entry));
    const fleet: FleetChangedEvent = { turbineId: entry.turbineId };
    await this.publish(FLEET_CHANGED, fleet);
    if (imported.newest) {
      await this.publish(
        TELEMETRY_RECEIVED,
        toTelemetryResponse(imported.newest),
      );
    }
    return {
      action,
      id: entry.id,
      turbine: toTurbineResponse(turbine),
      imported: imported.imported,
      duplicates: imported.duplicates,
    };
  }

  private async lock(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<UnallocatedTurbine> {
    const entry = await lockUnallocated(tx, id);
    if (!entry) {
      throw new NotFoundException(`Unallocated turbine ${id} not found`);
    }
    return entry;
  }

  private async lockPending(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<UnallocatedTurbine> {
    const entry = await this.lock(tx, id);
    if (entry.status !== 'pending') {
      throw new ConflictException(
        `${pairOf(entry)} is blocked: unblock it first`,
      );
    }
    return entry;
  }

  private turbineOf(
    tx: Prisma.TransactionClient,
    entry: UnallocatedTurbine,
  ): Promise<Turbine | null> {
    return tx.turbine.findUnique({ where: { turbineId: entry.turbineId } });
  }

  /** The entry's turbine for keep/move; 409 if it is (still) an unknown turbine. */
  private async knownTurbine(
    tx: Prisma.TransactionClient,
    entry: UnallocatedTurbine,
  ): Promise<Turbine> {
    const turbine = await this.turbineOf(tx, entry);
    if (!turbine) {
      throw new ConflictException(
        `Turbine ${entry.turbineId} is not in the fleet: assign it to a farm instead`,
      );
    }
    return turbine;
  }

  /**
   * Called after the commit. A Redis failure is logged, not thrown: the change is stored, and a
   * 500 would invite a retry that now fails with 404.
   */
  private async publish(type: string, data: unknown): Promise<void> {
    try {
      await this.events.publish(type, data);
    } catch (error) {
      this.logger.error(
        `Could not publish ${type}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

const pairOf = (entry: UnallocatedTurbine) =>
  `${entry.turbineId} reporting ${entry.reportedFarmId}`;

const changed = (
  action: UnallocatedChangedEvent['action'],
  entry: UnallocatedTurbine,
): UnallocatedChangedEvent => ({
  action,
  id: entry.id,
  turbineId: entry.turbineId,
});
