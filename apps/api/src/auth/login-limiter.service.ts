import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeEmail } from '@nextera/shared';
import { Redis } from 'ioredis';
import { createHash } from 'node:crypto';

/** Fixed window: it starts at a key's first attempt and no later attempt extends it. */
export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_LIMIT_EMAIL_IP = 5;
export const LOGIN_LIMIT_EMAIL = 20;
export const LOGIN_LIMIT_IP = 30;

export const LOGIN_LIMIT_KEY_PREFIX = 'login-limit:';

/** Short, so a slow or absent Redis costs a sign-in well under a second, then it fails open. */
const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

/**
 * KEYS: email + IP, email, IP. ARGV[1]: the window. Counts one attempt on every key, in one step,
 * and returns [count, ms left] per key. The expiry is set only while a key has none: testing
 * `count == 1` instead would restart the window of a key a success gave back down to 0.
 */
const RESERVE_SCRIPT = `
local reply = {}
for _, key in ipairs(KEYS) do
  local count = redis.call('INCR', key)
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then
    redis.call('PEXPIRE', key, ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  reply[#reply + 1] = count
  reply[#reply + 1] = ttl
end
return reply
`;

/**
 * KEYS: as above. ARGV[1]: '1' also deletes the email + IP key (a success). Gives back one
 * attempt per key, but never recreates an expired key or goes below 0.
 */
const RELEASE_SCRIPT = `
local first = 1
if ARGV[1] == '1' then
  redis.call('DEL', KEYS[1])
  first = 2
end
for i = first, #KEYS do
  if tonumber(redis.call('GET', KEYS[i]) or '0') > 0 then
    redis.call('DECR', KEYS[i])
  end
end
return 1
`;

export type LoginReservation =
  | { limited: true; retryAfterSeconds: number }
  | {
      limited: false;
      /** The sign-in succeeded: clears email + IP, gives back the attempt on the other two. */
      succeeded(): Promise<void>;
      /** The attempt never got an answer (e.g. the database failed): gives it back everywhere. */
      cancel(): Promise<void>;
    };

/** Nothing was counted (limiter disabled, or Redis unavailable), so there is nothing to give back. */
const NOT_COUNTED: LoginReservation = {
  limited: false,
  succeeded: () => Promise.resolve(),
  cancel: () => Promise.resolve(),
};

/** The Redis keys of an attempt, in the scripts' order. The email is only ever stored hashed. */
export function loginLimitKeys(
  email: string,
  ip: string,
): [emailIp: string, email: string, ip: string] {
  const hash = createHash('sha256').update(normalizeEmail(email)).digest('hex');
  return [
    `${LOGIN_LIMIT_KEY_PREFIX}email-ip:${hash}:${ip}`,
    `${LOGIN_LIMIT_KEY_PREFIX}email:${hash}`,
    `${LOGIN_LIMIT_KEY_PREFIX}ip:${ip}`,
  ];
}

/**
 * Limits failed sign-ins per email + IP, email and IP, across all API instances. An attempt
 * reserves its place before any hashing: argon2 is slow, so check-then-count would let a parallel
 * burst through. A failed attempt keeps its reservation; a success or a 429 gives it back, so only
 * failures use up a limit. Never throws: if Redis is down or slow, sign-in continues unlimited.
 */
@Injectable()
export class LoginLimiterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoginLimiterService.name);
  private readonly redis: Redis | null;
  /** The reconnect loop repeats the same error: log it once per outage. */
  private outageLogged = false;

  constructor(config: ConfigService) {
    if (config.get<string>('LOGIN_RATE_LIMIT_ENABLED') === 'false') {
      this.redis = null;
      return;
    }
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      enableOfflineQueue: false, // while disconnected, commands fail at once instead of waiting
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      disconnectTimeout: COMMAND_TIMEOUT_MS, // a peer that never answers can't hold up the boot
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => Math.min(times * 200, MAX_RECONNECT_DELAY_MS),
    });
    this.redis.on('ready', () => {
      this.outageLogged = false;
    });
    this.redis.on('error', (error: Error) => {
      if (this.outageLogged) return;
      this.outageLogged = true;
      this.warn('Redis unavailable', error);
    });
  }

  /** Bounded by the timeouts above. A failure doesn't stop the API: the client keeps reconnecting. */
  async onModuleInit() {
    await this.redis?.connect().catch(() => undefined); // logged by the 'error' listener
  }

  onModuleDestroy() {
    this.redis?.disconnect(); // also stops reconnecting; there is nothing to flush
  }

  /** Counts this attempt and says whether it may go on to the password check. */
  async reserve(email: string, ip: string): Promise<LoginReservation> {
    if (!this.redis) return NOT_COUNTED;
    const keys = loginLimitKeys(email, ip);

    let reply: number[];
    try {
      reply = (await this.redis.eval(
        RESERVE_SCRIPT,
        keys.length,
        ...keys,
        LOGIN_WINDOW_MS,
      )) as number[];
    } catch (error) {
      this.warn('Limit not applied, sign-in continues', error);
      return NOT_COUNTED;
    }

    const limits = [LOGIN_LIMIT_EMAIL_IP, LOGIN_LIMIT_EMAIL, LOGIN_LIMIT_IP];
    const waits = limits.flatMap((limit, i) =>
      reply[i * 2] > limit ? [reply[i * 2 + 1]] : [],
    );
    if (waits.length > 0) {
      await this.release(keys, false);
      return {
        limited: true,
        retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...waits) / 1000)),
      };
    }
    return {
      limited: false,
      succeeded: () => this.release(keys, true),
      cancel: () => this.release(keys, false),
    };
  }

  private async release(keys: string[], clearEmailIp: boolean): Promise<void> {
    try {
      await this.redis!.eval(
        RELEASE_SCRIPT,
        keys.length,
        ...keys,
        clearEmailIp ? '1' : '0',
      );
    } catch (error) {
      this.warn('Reservation not given back', error);
    }
  }

  /** Only the message: never the REDIS_URL, the email or the keys. */
  private warn(what: string, error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Login limiter: ${what} (${reason})`);
  }
}
