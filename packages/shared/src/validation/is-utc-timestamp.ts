import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
} from 'class-validator';

/**
 * How far in the future a timestamp may be: turbine and server clocks drift a little, so a reading
 * measured "now" can look up to a few minutes ahead. Anything later is rejected, because "latest"
 * and trends use the maximum measurement `timestamp`: one far-future reading would stay a turbine's
 * latest forever.
 */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** The earliest accepted measurement time (2000-01-01T00:00:00Z); older values are unit mix-ups. */
export const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);

/**
 * A full ISO 8601 / RFC 3339 date-time with an explicit zone: YYYY-MM-DDTHH:mm[:ss[.fraction]]
 * followed by Z or ±HH:MM. Week dates, ordinal dates, date-only and zone-less forms don't match
 * (`new Date()` turns them into Invalid Date, the wrong day, or server-local time).
 */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export interface UtcTimestampOptions {
  /** Earliest accepted instant (epoch ms), inclusive. Default: no lower bound. */
  minMs?: number;
  /**
   * Accept instants of any distance in the future. Default false: at most MAX_FUTURE_SKEW_MS ahead
   * of the clock (measurement times). Set it for query bounds, where a future `to` is legitimate
   * (the web app's whole-UTC-day ranges end at tomorrow 00:00Z).
   */
  allowFuture?: boolean;
}

export type TimestampProblem = 'format' | 'calendar' | 'future' | 'past';

/**
 * Why `value` isn't an accepted timestamp, or undefined if it is. Reads the clock (Date.now) unless
 * `allowFuture` is set.
 */
export function timestampProblem(
  value: unknown,
  { minMs, allowFuture = false }: UtcTimestampOptions = {},
): TimestampProblem | undefined {
  if (typeof value !== 'string') return 'format';
  const match = DATE_TIME.exec(value);
  if (!match) return 'format';

  // Date.parse rolls over out-of-range fields (2026-02-30 → 2 March), so check them first.
  const [, y, mo, d, h, mi, s, oh, om] = match.map((part) => Number(part ?? 0));
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth =
    mo === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31;
  const inRange =
    mo >= 1 &&
    mo <= 12 &&
    d >= 1 &&
    d <= daysInMonth &&
    h <= 23 &&
    mi <= 59 &&
    s <= 59 &&
    oh <= 23 &&
    om <= 59;
  const ms = Date.parse(value);
  if (!inRange || !Number.isFinite(ms)) return 'calendar';

  if (!allowFuture && ms > Date.now() + MAX_FUTURE_SKEW_MS) return 'future';
  if (minMs !== undefined && ms < minMs) return 'past';
  return undefined;
}

/** The validation message for `problem` on the field `property` (e.g. "from"). */
export function timestampProblemMessage(
  problem: TimestampProblem,
  property: string,
  minMs?: number,
): string {
  return MESSAGES[problem](property, minMs);
}

const MESSAGES: Record<
  TimestampProblem,
  (property: string, minMs?: number) => string
> = {
  format: (p) =>
    `${p} must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)`,
  calendar: (p) => `${p} must be a real calendar date and time`,
  future: (p) =>
    `${p} must not be more than ${MAX_FUTURE_SKEW_MS / 60_000} minutes in the future`,
  past: (p, minMs) =>
    `${p} must not be before ${new Date(minMs ?? 0).toISOString().replace('.000Z', 'Z')}`,
};

/**
 * An instant: a full date-time with an explicit zone (see DATE_TIME) and a real calendar date; by
 * default not more than MAX_FUTURE_SKEW_MS ahead of the clock (unless `allowFuture`), and not
 * before `minMs` if given. Shared by the ingestion payloads and the API's from/to query bounds.
 */
export function IsUtcTimestamp(
  options: UtcTimestampOptions = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object, propertyName) => {
    registerDecorator({
      name: 'isUtcTimestamp',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate: (value: unknown) =>
          timestampProblem(value, options) === undefined,
        defaultMessage: (args?: ValidationArguments) =>
          MESSAGES[timestampProblem(args?.value, options) ?? 'format'](
            args?.property ?? 'value',
            options.minMs,
          ),
      },
    });
  };
}
