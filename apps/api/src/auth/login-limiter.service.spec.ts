import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { createServer, type Server } from 'node:net';
import {
  LOGIN_LIMIT_EMAIL,
  LOGIN_LIMIT_EMAIL_IP,
  LOGIN_LIMIT_IP,
  LOGIN_WINDOW_MS,
  LoginLimiterService,
  loginLimitKeys,
} from './login-limiter.service.js';

const EMAIL = 'owner@nextera.local';
const IP = '203.0.113.9';

/** The script's reply: [count, ms left] per key, in the order email + IP, email, IP. */
const reply = (emailIp: number, email: number, ip: number, msLeft = 60_000) => [
  emailIp,
  msLeft,
  email,
  msLeft,
  ip,
  msLeft,
];

function limiterWith(env: Record<string, string> = {}) {
  return new LoginLimiterService(
    new ConfigService({ REDIS_URL: 'redis://127.0.0.1:1', ...env }),
  );
}

/** The real client, never connected (lazyConnect), with its one command mocked. */
function mockedEval(service: LoginLimiterService) {
  const redis = (service as unknown as { redis: Redis }).redis;
  return vi.spyOn(redis, 'eval');
}

describe('LoginLimiterService', () => {
  describe('thresholds', () => {
    it.each([
      ['email + IP', reply(LOGIN_LIMIT_EMAIL_IP, 1, 1)],
      ['email', reply(1, LOGIN_LIMIT_EMAIL, 1)],
      ['IP', reply(1, 1, LOGIN_LIMIT_IP)],
    ])('allows the attempt that reaches the %s limit', async (_key, counts) => {
      const service = limiterWith();
      mockedEval(service).mockResolvedValue(counts);

      expect(await service.reserve(EMAIL, IP)).toMatchObject({
        limited: false,
      });
    });

    it.each([
      ['email + IP', reply(LOGIN_LIMIT_EMAIL_IP + 1, 1, 1)],
      ['email', reply(1, LOGIN_LIMIT_EMAIL + 1, 1)],
      ['IP', reply(1, 1, LOGIN_LIMIT_IP + 1)],
    ])(
      'refuses the attempt over the %s limit and gives it back',
      async (_key, counts) => {
        const service = limiterWith();
        const evalMock = mockedEval(service).mockResolvedValueOnce(counts);
        evalMock.mockResolvedValueOnce(1);

        expect(await service.reserve(EMAIL, IP)).toEqual({
          limited: true,
          retryAfterSeconds: 60,
        });
        // Give-back: decrements every key, deletes none.
        const keys = loginLimitKeys(EMAIL, IP);
        expect(evalMock).toHaveBeenLastCalledWith(
          expect.stringContaining('DECR'),
          3,
          ...keys,
          '0',
        );
      },
    );
  });

  describe('expiry', () => {
    it('reserves with the 15-minute window', async () => {
      const service = limiterWith();
      const evalMock = mockedEval(service).mockResolvedValue(reply(1, 1, 1));

      await service.reserve(EMAIL, IP);

      expect(LOGIN_WINDOW_MS).toBe(900_000);
      expect(evalMock).toHaveBeenCalledWith(
        expect.stringContaining('PEXPIRE'),
        3,
        ...loginLimitKeys(EMAIL, IP),
        LOGIN_WINDOW_MS,
      );
    });

    it('waits for the longest window among the limits actually exceeded, rounded up', async () => {
      const service = limiterWith();
      mockedEval(service).mockResolvedValue([
        6,
        90_001, // over, the longest that counts
        21,
        10_000, // over
        1,
        800_000, // under its limit: ignored
      ]);

      expect(await service.reserve(EMAIL, IP)).toMatchObject({
        retryAfterSeconds: 91,
      });
    });

    it('never answers Retry-After: 0', async () => {
      const service = limiterWith();
      mockedEval(service).mockResolvedValue(reply(6, 1, 1, 1));

      expect(await service.reserve(EMAIL, IP)).toMatchObject({
        retryAfterSeconds: 1,
      });
    });
  });

  describe('release', () => {
    const reserved = async (service: LoginLimiterService) => {
      const reservation = await service.reserve(EMAIL, IP);
      if (reservation.limited) throw new Error('expected a reservation');
      return reservation;
    };

    it('a success deletes email + IP and gives back the other two', async () => {
      const service = limiterWith();
      const evalMock = mockedEval(service).mockResolvedValue(reply(1, 1, 1));

      await (await reserved(service)).succeeded();

      expect(evalMock).toHaveBeenLastCalledWith(
        expect.stringContaining('DEL'),
        3,
        ...loginLimitKeys(EMAIL, IP),
        '1',
      );
    });

    it('a cancelled attempt is given back everywhere, deleting nothing', async () => {
      const service = limiterWith();
      const evalMock = mockedEval(service).mockResolvedValue(reply(1, 1, 1));

      await (await reserved(service)).cancel();

      expect(evalMock).toHaveBeenLastCalledWith(
        expect.stringContaining('DECR'),
        3,
        ...loginLimitKeys(EMAIL, IP),
        '0',
      );
    });

    it('a failed release is only a warning', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const service = limiterWith();
      const evalMock = mockedEval(service).mockResolvedValueOnce(
        reply(1, 1, 1),
      );
      const reservation = await reserved(service);
      evalMock.mockRejectedValueOnce(new Error('Command timed out'));

      await expect(reservation.succeeded()).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Command timed out'),
      );
      warn.mockRestore();
    });
  });

  describe('keys', () => {
    it('hash the normalised email and never contain it', () => {
      const keys = loginLimitKeys(' Owner@Nextera.LOCAL ', IP);

      expect(keys).toEqual(loginLimitKeys(EMAIL, IP));
      expect(keys.join()).not.toContain('owner');
      expect(keys[0]).toContain(IP);
      expect(keys[2]).toContain(IP);
    });
  });

  describe('fails open', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    let service: LoginLimiterService | undefined;
    let server: Server | undefined;

    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      service?.onModuleDestroy();
      server?.close();
      service = server = undefined;
      warn.mockRestore();
    });

    /** Boots a real client against `url`; returns how long boot + one attempt took. */
    const attempt = async (url: string) => {
      service = limiterWith({ REDIS_URL: url });
      const started = Date.now();
      await service.onModuleInit();
      const reservation = await service.reserve(EMAIL, IP);
      return { reservation, elapsed: Date.now() - started };
    };

    it('with nothing listening: allowed at once, with a warning, and a no-op release', async () => {
      const { reservation, elapsed } = await attempt('redis://127.0.0.1:1');

      expect(reservation.limited).toBe(false);
      expect(elapsed).toBeLessThan(2_000);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('sign-in continues'),
      );
      if (!reservation.limited) {
        await expect(reservation.succeeded()).resolves.toBeUndefined();
      }
    });

    it('with a server that accepts but never answers: allowed within the timeouts', async () => {
      server = createServer(() => {});
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', resolve),
      );
      const { port } = server.address() as { port: number };

      const { reservation, elapsed } = await attempt(
        `redis://127.0.0.1:${port}`,
      );

      expect(reservation.limited).toBe(false);
      expect(elapsed).toBeLessThan(3_000);
    });

    it('when a command times out on a live connection', async () => {
      service = limiterWith();
      mockedEval(service).mockRejectedValue(new Error('Command timed out'));

      expect((await service.reserve(EMAIL, IP)).limited).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Command timed out'),
      );
    });

    it('never logs the REDIS_URL password', async () => {
      await attempt('redis://:s3cret-password@127.0.0.1:1');

      expect(JSON.stringify(warn.mock.calls)).not.toContain('s3cret-password');
    });
  });

  describe('LOGIN_RATE_LIMIT_ENABLED=false', () => {
    it('uses no Redis client at all', async () => {
      const service = limiterWith({ LOGIN_RATE_LIMIT_ENABLED: 'false' });

      expect((service as unknown as { redis: Redis | null }).redis).toBeNull();
      await service.onModuleInit();
      const reservation = await service.reserve(EMAIL, IP);
      expect(reservation.limited).toBe(false);
      if (!reservation.limited) await reservation.succeeded();
      service.onModuleDestroy();
    });
  });
});
