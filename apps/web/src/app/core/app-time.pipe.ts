import { Pipe, PipeTransform, inject } from '@angular/core';
import { TimeZoneSettings, formatIn } from './time-zone';

/**
 * A time in the user's zone (Settings: UTC or local), with a date-fns pattern:
 * `{{ r.timestamp | appTime: 'MMM d, HH:mm' }}` → "Jan 2, 03:20"; `: true` adds the zone's short
 * name for that instant ("Jan 2, 03:20 UTC", "Jan 1, 21:20 CST"). Null/empty/invalid → "".
 *
 * Impure, so it follows a zone change; it reads the zone signal (so OnPush views are refreshed)
 * and formats again only when its arguments or the zone changed.
 */
@Pipe({ name: 'appTime', pure: false })
export class AppTimePipe implements PipeTransform {
  private readonly settings = inject(TimeZoneSettings);
  private last?: { key: string; text: string };

  transform(
    value: Date | number | string | null | undefined,
    pattern: string,
    withZone = false,
  ): string {
    const zone = this.settings.zone();
    if (value === null || value === undefined || value === '') return '';
    const t = typeof value === 'string' ? Date.parse(value) : +value;
    if (Number.isNaN(t)) return '';
    const key = `${t}|${pattern}|${zone}|${withZone}`;
    if (this.last?.key !== key) this.last = { key, text: formatIn(t, pattern, zone, withZone) };
    return this.last.text;
  }
}
