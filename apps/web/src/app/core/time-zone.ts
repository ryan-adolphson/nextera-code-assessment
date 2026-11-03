import { Injectable, InjectionToken, computed, inject, linkedSignal, signal } from '@angular/core';
import { tz, tzName, tzOffset } from '@date-fns/tz';
import { utc } from '@date-fns/utc';
import { format } from 'date-fns';
import { millisecondsInMinute } from 'date-fns/constants';

/**
 * How times are shown: in UTC (the default) or in the browser's time zone. Every date-fns call
 * that formats or does calendar maths takes the zone's context (`{ in: zoneContext(zone) }`):
 * `utc` for UTC, `tz(zone)` (`@date-fns/tz`, DST-aware through Intl) otherwise.
 */
export type TimeZoneMode = 'utc' | 'local';

/** The zone name used for UTC mode (and the zone the API speaks). */
export const UTC_ZONE = 'UTC';

/** A date-fns `in` context: makes date-fns read and build dates in one zone. */
export type DateContext = (value: Date | number | string) => Date;

/**
 * The browser's IANA time zone ("America/Chicago"), or "UTC" when the browser reports none (or one
 * Intl can't use). A token, so tests pin a zone whatever the machine running them uses.
 */
export const BROWSER_TIME_ZONE = new InjectionToken<string>('BROWSER_TIME_ZONE', {
  providedIn: 'root',
  factory: () => validZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
});

/** `zone` if Intl knows it, else UTC. */
export function validZone(zone: string | undefined): string {
  return zone && !Number.isNaN(tzOffset(zone, new Date(0))) ? zone : UTC_ZONE;
}

const contexts = new Map<string, DateContext>([[UTC_ZONE, utc]]);

/** The date-fns `in` context of a zone (cached: one per zone). */
export function zoneContext(zone: string): DateContext {
  let ctx = contexts.get(zone);
  if (!ctx) contexts.set(zone, (ctx = tz(zone)));
  return ctx;
}

/** The zone's offset from UTC at instant `t`, in ms (e.g. −5 h for Chicago in summer). */
export function zoneOffsetMs(zone: string, t: number): number {
  return zone === UTC_ZONE ? 0 : tzOffset(zone, new Date(t)) * millisecondsInMinute;
}

/** "UTC" in UTC; the zone's short name at `t` otherwise ("CST", "CDT", "GMT+5:30"). */
export function zoneAbbr(zone: string, t: number): string {
  return zone === UTC_ZONE ? 'UTC' : tzName(zone, new Date(t), 'short');
}

/** "UTC−5", "UTC+5:30", "UTC" (offset 0): the zone's offset at `t` (so DST is right). */
export function offsetLabel(zone: string, t: number): string {
  const minutes = Math.round(zoneOffsetMs(zone, t) / millisecondsInMinute);
  if (minutes === 0) return 'UTC';
  const abs = Math.abs(minutes);
  const hm = abs % 60 ? `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}` : abs / 60;
  return `UTC${minutes < 0 ? '−' : '+'}${hm}`;
}

/** The clock shown: 24-hour ("14:05", the default) or 12-hour ("2:05 PM"). */
export type ClockFormat = '24h' | '12h';

/** A pattern for the 12-hour clock: every `HH:mm` becomes `h:mm a` (other patterns are kept). */
export function clockPattern(pattern: string, clock12: boolean): string {
  return clock12 ? pattern.replaceAll('HH:mm', 'h:mm a') : pattern;
}

/**
 * `t` formatted with a date-fns pattern in `zone`, plus " <abbr>" when `withZone`. With `clock12`,
 * `HH:mm` in the pattern is shown as `h:mm a`.
 */
export function formatIn(
  t: Date | number | string,
  pattern: string,
  zone: string,
  withZone = false,
  clock12 = false,
): string {
  const text = format(t, clockPattern(pattern, clock12), { in: zoneContext(zone) });
  return withZone ? `${text} ${zoneAbbr(zone, +new Date(t))}` : text;
}

export const TIME_ZONE_STORAGE_PREFIX = 'nextera.timeZone.';
export const CLOCK_STORAGE_PREFIX = 'nextera.clock.';

/**
 * The user's time-zone setting (Settings page): UTC (default) or the browser's zone. Saved in this
 * browser's localStorage per user email (`nextera.timeZone.<email>`), so another user on the same
 * browser keeps their own; storage errors are ignored (the setting then lives in memory) and an
 * unknown stored value means UTC. `FleetShell` names the signed-in user (`useAccount`).
 */
@Injectable({ providedIn: 'root' })
export class TimeZoneSettings {
  /** The browser's zone (what "Local" means). */
  readonly browserZone = inject(BROWSER_TIME_ZONE);
  private readonly account = signal<string | null>(null);
  /** The chosen mode: the account's saved one, until `setMode` (re-read when the account changes). */
  private readonly selected = linkedSignal<TimeZoneMode>(() => readMode(this.account()));

  /** The chosen clock: the account's saved one, until `setClock` (24-hour when none or invalid). */
  private readonly clockChoice = linkedSignal<ClockFormat>(() => readClock(this.account()));

  readonly mode = this.selected.asReadonly();
  readonly clock = this.clockChoice.asReadonly();
  /** Whether times show on the 12-hour clock ("2:05 PM"). */
  readonly clock12 = computed(() => this.clockChoice() === '12h');
  /** The zone times are shown in: "UTC" or the browser's zone. */
  readonly zone = computed(() => (this.mode() === 'local' ? this.browserZone : UTC_ZONE));
  /** The date-fns `in` context for `zone`. */
  readonly ctx = computed(() => zoneContext(this.zone()));
  /** "UTC" or "local time (America/Chicago)": for "Times are …" notes. */
  readonly label = computed(() =>
    this.zone() === UTC_ZONE ? 'UTC' : `local time (${this.zone()})`,
  );
  /** A short tag for column headers and labels: "UTC" or "local". */
  readonly tag = computed(() => (this.zone() === UTC_ZONE ? 'UTC' : 'local'));

  /** Whose setting applies (null: nobody signed in → UTC, nothing saved). */
  useAccount(email: string | null): void {
    this.account.set(email ? email.trim().toLowerCase() : null);
  }

  /** Chooses UTC or local time, and saves it for the signed-in user. */
  setMode(mode: TimeZoneMode): void {
    this.selected.set(mode);
    const account = this.account();
    if (!account) return;
    try {
      localStorage.setItem(TIME_ZONE_STORAGE_PREFIX + account, mode);
    } catch {
      // memory only (privacy mode, full storage)
    }
  }

  /** Chooses the 24-hour or 12-hour clock, and saves it for the signed-in user. */
  setClock(clock: ClockFormat): void {
    this.clockChoice.set(clock);
    const account = this.account();
    if (!account) return;
    try {
      localStorage.setItem(CLOCK_STORAGE_PREFIX + account, clock);
    } catch {
      // memory only (privacy mode, full storage)
    }
  }

  /** The current zone's offset at `t` ("UTC−5"). */
  offsetLabel(t: number): string {
    return offsetLabel(this.zone(), t);
  }
}

function readClock(account: string | null): ClockFormat {
  if (!account) return '24h';
  try {
    return localStorage.getItem(CLOCK_STORAGE_PREFIX + account) === '12h' ? '12h' : '24h';
  } catch {
    return '24h';
  }
}

function readMode(account: string | null): TimeZoneMode {
  if (!account) return 'utc';
  try {
    return localStorage.getItem(TIME_ZONE_STORAGE_PREFIX + account) === 'local' ? 'local' : 'utc';
  } catch {
    return 'utc';
  }
}
