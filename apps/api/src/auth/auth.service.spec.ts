import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PrismaService } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { AuthService, INVALID_CREDENTIALS } from './auth.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

describe('AuthService', () => {
  const passwords = new PasswordService();
  const tokens = new TokenService(
    new ConfigService({
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      JWT_ISSUER: 'nextera-api',
      JWT_AUDIENCE: 'nextera-web',
    }),
  );
  let prisma: DeepMockProxy<PrismaService>;
  let service: AuthService;
  let user: {
    id: string;
    email: string;
    passwordHash: string;
    role: 'owner';
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
  };

  beforeAll(async () => {
    await passwords.onModuleInit();
    user = {
      id: '6f1c2b1e-8a4d-4c2b-9b1a-3d2e1f0a9b8c',
      email: 'owner@nextera.local',
      passwordHash: await passwords.hash('correct horse battery'),
      role: 'owner',
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    service = new AuthService(prisma, passwords, tokens);
  });

  it('returns a 24-hour token and the user for the right password, looking up the normalised email', async () => {
    prisma.user.findUnique.mockResolvedValue(user);

    const res = await service.login(
      ' Owner@Nextera.local ',
      'correct horse battery',
    );

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'owner@nextera.local' },
    });
    expect(res.user).toEqual({ email: 'owner@nextera.local', role: 'owner' });
    expect(await tokens.verify(res.accessToken)).toMatchObject({
      sub: user.id,
      role: 'owner',
    });
    const ttl = new Date(res.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(24 * 3600_000 - 5_000);
    expect(ttl).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('gives a wrong password, an unknown email and an inactive user the same 401', async () => {
    const verify = vi.spyOn(passwords, 'verify');
    const failures: unknown[] = [];

    prisma.user.findUnique.mockResolvedValueOnce(user);
    failures.push(
      await service.login(user.email, 'wrong').catch((e: unknown) => e),
    );
    prisma.user.findUnique.mockResolvedValueOnce(null);
    failures.push(
      await service
        .login('nobody@nextera.local', 'wrong')
        .catch((e: unknown) => e),
    );
    prisma.user.findUnique.mockResolvedValueOnce({ ...user, active: false });
    failures.push(
      await service
        .login(user.email, 'correct horse battery')
        .catch((e: unknown) => e),
    );

    for (const error of failures) {
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect((error as UnauthorizedException).message).toBe(
        INVALID_CREDENTIALS,
      );
    }
    // The unknown email still verified a (dummy) argon2 hash: the same work as a real user.
    expect(verify).toHaveBeenCalledTimes(3);
  });
});
