import { NotFoundException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@nextera/shared';
import { Public, Roles } from './auth.decorators.js';
import { RolesGuard } from './roles.guard.js';

class Routes {
  @Public() health() {}
  @Roles('viewer') read() {}
  @Roles('owner') write() {}
  unannotated() {}
}

@Roles('owner')
class OwnerController {
  inherited() {}
  @Roles('viewer') relaxed() {}
}

const contextFor = (
  cls: object,
  handler: () => void,
  role?: Role,
): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({
      getRequest: () => ({
        method: 'GET',
        originalUrl: '/api/reports/telemetry?x=1',
        user: role && { id: 'u', email: 'e', role, expiresAt: new Date() },
      }),
    }),
  }) as unknown as ExecutionContext;

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const routes = Routes.prototype;

  it('lets public routes through without a user', () => {
    expect(guard.canActivate(contextFor(Routes, routes.health))).toBe(true);
  });

  it.each([
    ['viewer', 'read', true],
    ['viewer', 'write', false],
    ['owner', 'read', true],
    ['owner', 'write', true],
    ['admin', 'write', true],
  ] as const)('%s on a %s route: %s', (role, route, allowed) => {
    const run = () =>
      guard.canActivate(contextFor(Routes, routes[route], role));
    if (allowed) expect(run()).toBe(true);
    else expect(run).toThrow(NotFoundException);
  });

  it('answers a too-low role with the 404 of a route that does not exist', () => {
    try {
      guard.canActivate(contextFor(Routes, routes.write, 'viewer'));
      expect.unreachable();
    } catch (error) {
      expect((error as NotFoundException).getResponse()).toEqual({
        statusCode: 404,
        error: 'Not Found',
        message: 'Cannot GET /api/reports/telemetry?x=1',
      });
    }
  });

  it('makes unannotated routes admin-only (fails closed)', () => {
    expect(() =>
      guard.canActivate(contextFor(Routes, routes.unannotated, 'owner')),
    ).toThrow(NotFoundException);
    expect(
      guard.canActivate(contextFor(Routes, routes.unannotated, 'admin')),
    ).toBe(true);
  });

  it('reads the handler first, then the controller', () => {
    const owner = OwnerController.prototype;
    expect(() =>
      guard.canActivate(contextFor(OwnerController, owner.inherited, 'viewer')),
    ).toThrow(NotFoundException);
    expect(
      guard.canActivate(contextFor(OwnerController, owner.relaxed, 'viewer')),
    ).toBe(true);
  });

  it('denies a request without a user', () => {
    expect(() => guard.canActivate(contextFor(Routes, routes.read))).toThrow(
      NotFoundException,
    );
  });
});
