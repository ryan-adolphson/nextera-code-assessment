import type { Page } from '@playwright/test';

/**
 * Fixes the page's `Date` at `at` (like `page.clock.setFixedTime`) in a way that keeps Date
 * subclasses working, for tests that run the browser outside UTC.
 *
 * Why not `page.clock`: its fake `Date` is a plain function whose constructor *returns* a native
 * Date, so `class X extends Date` (date-fns' `UTCDate` and `@date-fns/tz`'s `TZDate`) gets plain
 * Dates back, without the subclass's methods or zone. Every time the app formats then comes out in
 * the browser's zone: in an America/Chicago browser, "UTC" times are shown 6 h early (and Local
 * looks right only by accident). With `timezoneId: 'UTC'` (playwright.config.ts) the two coincide,
 * which is why the other specs can use `page.clock`.
 *
 * Here `Date` is a Proxy of the native constructor: `new Date()` and `Date.now()` give `at`, every
 * other call is the native one, and a subclass's `super(...)` builds an instance of the subclass
 * (the construct trap passes `newTarget` on). `instanceof Date` and `Date.prototype` are untouched.
 * Timers and `performance.now()` keep running, as with `setFixedTime`. Installed as an init script,
 * so it applies to every navigation and reload of the page.
 */
export async function fixBrowserDate(page: Page, at: Date): Promise<void> {
  await page.addInitScript((fixed: number) => {
    const NativeDate = Date;
    const FixedDate: DateConstructor = new Proxy(NativeDate, {
      construct(target, args, newTarget) {
        return Reflect.construct(
          target,
          args.length ? args : [fixed],
          newTarget === FixedDate ? target : newTarget,
        );
      },
      // Date() without `new`: a string, as natively.
      apply: () => new NativeDate(fixed).toString(),
      get: (target, prop) => (prop === 'now' ? () => fixed : Reflect.get(target, prop)),
    });
    globalThis.Date = FixedDate;
  }, at.getTime());
}

/**
 * `iso` as the app's "MMM d, HH:mm" (date-fns, en-US) in `zone`, e.g. "Jan 2, 17:55": an
 * independent oracle (Node's Intl) for times the app formats in UTC or the browser's zone.
 */
export function shortTimeIn(iso: string, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${part('month')} ${part('day')}, ${part('hour')}:${part('minute')}`;
}
