import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { AllowQueryToken, Public, Roles } from './auth.decorators.js';
import { AuthGuard } from './auth.guard.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { TokenService } from './token.service.js';

const USER = {
  id: '6f1c2b1e-8a4d-4c2b-9b1a-3d2e1f0a9b8c',
  email: 'viewer@nextera.local',
  role: 'viewer' as const,
  active: true,
};

class Routes {
  @Public() login() {}
  @Roles('viewer') farms() {}
  @Roles('viewer') @AllowQueryToken() events() {}
}

describe('AuthGuard', () => {
  const tokens = new TokenService(
    new ConfigService({
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      JWT_ISSUER: 'nextera-api',
      JWT_AUDIENCE: 'nextera-web',
    }),
  );
  let prisma: DeepMockProxy<PrismaService>;
  let guard: AuthGuard;
  let token: string;
  let expiresAt: Date;

  beforeAll(async () => {
    ({ token, expiresAt } = await tokens.sign(USER));
  });

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.user.findUnique.mockResolvedValue(USER as never);
    guard = new AuthGuard(new Reflector(), tokens, prisma);
  });

  const run = (handler: () => void, request: Partial<AuthenticatedRequest>) => {
    const req = {
      method: 'GET',
      headers: {},
      query: {},
      ...request,
    } as AuthenticatedRequest;
    const setHeader = vi.fn();
    const context = {
      getHandler: () => handler,
      getClass: () => Routes,
      switchToHttp: () => ({
        getRequest: () => req,
        getResponse: () => ({ setHeader }),
      }),
    } as unknown as ExecutionContext;
    return { req, setHeader, result: guard.canActivate(context) };
  };
  const routes = Routes.prototype;
  const bearer = (value: string) => ({
    headers: { authorization: `Bearer ${value}` },
  });

  it('lets public routes through without a token or a database query', async () => {
    await expect(run(routes.login, {}).result).resolves.toBe(true);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('accepts a valid Bearer token and attaches the current user', async () => {
    const { req, result } = run(routes.farms, bearer(token));
    await expect(result).resolves.toBe(true);
    expect(req.user).toEqual({
      id: USER.id,
      email: USER.email,
      role: 'viewer',
      expiresAt,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: USER.id },
      select: { id: true, email: true, role: true, active: true },
    });
  });

  it('uses the role in the database, not the claim (a demotion applies at once)', async () => {
    const adminToken = (await tokens.sign({ id: USER.id, role: 'admin' }))
      .token;
    const { req, result } = run(routes.farms, bearer(adminToken));
    await result;
    expect(req.user?.role).toBe('viewer');
  });

  it.each([
    ['no token', () => ({})],
    ['an empty Bearer', () => ({ headers: { authorization: 'Bearer ' } })],
    [
      'another scheme',
      () => ({ headers: { authorization: `Basic ${token}` } }),
    ],
    ['a forged token', () => bearer(`${token.slice(0, -4)}AAAA`)],
    ['garbage', () => bearer('nope')],
  ])(
    'answers %s with 401 and WWW-Authenticate: Bearer',
    async (_case, request) => {
      const { result, setHeader } = run(
        routes.farms,
        request() as Partial<AuthenticatedRequest>,
      );
      await expect(result).rejects.toThrow(UnauthorizedException);
      expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    },
  );

  it('answers 401 for a deleted or inactive user', async () => {
    prisma.user.findUnique.mockResolvedValueOnce(null);
    await expect(run(routes.farms, bearer(token)).result).rejects.toThrow(
      UnauthorizedException,
    );
    prisma.user.findUnique.mockResolvedValueOnce({
      ...USER,
      active: false,
    } as never);
    await expect(run(routes.farms, bearer(token)).result).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('accepts ?access_token= only on routes marked @AllowQueryToken (GET /api/events)', async () => {
    const query = {
      query: { access_token: token },
    } as Partial<AuthenticatedRequest>;
    await expect(run(routes.events, query).result).resolves.toBe(true);
    await expect(run(routes.farms, query).result).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      run(routes.events, { ...query, method: 'POST' }).result,
    ).rejects.toThrow(UnauthorizedException);
  });
});
