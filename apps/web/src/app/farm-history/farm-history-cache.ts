import { Injectable, inject } from '@angular/core';
import { minutesToMilliseconds } from 'date-fns';
import { NOW } from '../core/clock';
import { DayRange } from '../core/days';
import { FarmDailyHistory } from './farm-history.model';

/** How long a loaded daily history is reused: the farm rollup job's schedule (every 15 min). */
export const FARM_HISTORY_FRESH_MS = minutesToMilliseconds(15);

/** What a cached daily history answers: a farm's range (preset) in a zone, over [from, to). */
export interface FarmHistoryKey extends DayRange {
  farmId: string;
  range: string;
  zone: string;
}

/**
 * The daily histories loaded this session, by (farm, range, zone): switching tabs or ranges back
 * shows them without a request while they are fresh (loaded under 15 minutes ago on the client
 * clock). An entry for other days (the range moved on at midnight) is a miss. Provided by
 * `FleetShell`, so signing out (which destroys the shell) forgets it.
 */
@Injectable()
export class FarmHistoryCache {
  private readonly now = inject(NOW);
  private readonly entries = new Map<
    string,
    { at: number; key: FarmHistoryKey; value: FarmDailyHistory }
  >();

  /** The fresh history for `key`, or null (none, other days, or 15 minutes old). */
  get(key: FarmHistoryKey): FarmDailyHistory | null {
    const entry = this.entries.get(id(key));
    if (!entry || entry.key.from !== key.from || entry.key.to !== key.to) return null;
    return this.now() - entry.at < FARM_HISTORY_FRESH_MS ? entry.value : null;
  }

  set(key: FarmHistoryKey, value: FarmDailyHistory): void {
    this.entries.set(id(key), { at: this.now(), key, value });
  }
}

const id = ({ farmId, range, zone }: FarmHistoryKey) => JSON.stringify([farmId, range, zone]);
