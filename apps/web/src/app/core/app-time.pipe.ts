import { Pipe, PipeTransform, inject } from '@angular/core';
import { TimeZoneSettings, formatIn } from './time-zone';

/**
 * A time in the user's zone (Settings: UTC or local), with a date-fns pattern:
 * `{{ r.timestamp | appTime: 'MMM d, HH:mm' }}` → "Jan 2, 03:20"; `: true` adds the zone's short
 * name for that instant ("Jan 2, 03:20 UTC", "Jan 1, 21:20 CST"). Null/empty/invalid → "".
 *
 * With the 12-hour clock (Settings) `HH:mm` shows as `h:mm a` ("Jan 2, 3:20 AM").
 *
 * Impure, so it follows a zone or clock change; it reads the zone signal (so OnPush views are refreshed)
 * and formats again only when its arguments or the zone or clock changed.
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
    const clock12 = this.settings.clock12();
    if (value === null || value === undefined || value === '') return '';
    const t = typeof value === 'string' ? Date.parse(value) : +value;
    if (Number.isNaN(t)) return '';
    const key = `${t}|${pattern}|${zone}|${withZone}|${clock12}`;
    if (this.last?.key !== key)
      this.last = { key, text: formatIn(t, pattern, zone, withZone, clock12) };
    return this.last.text;
  }
}
