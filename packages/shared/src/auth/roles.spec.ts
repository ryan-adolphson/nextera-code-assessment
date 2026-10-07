import { Role } from '../generated/prisma/enums.js';
import { ROLE_RANK, ROLES, hasRole, isRole } from './roles.js';

describe('roles', () => {
  it('are viewer < owner < admin (apps/web/src/app/core/auth/roles.ts mirrors these names)', () => {
    expect(Object.values(Role)).toEqual(['viewer', 'owner', 'admin']);
    expect(ROLES).toEqual(['viewer', 'owner', 'admin']);
    expect(ROLE_RANK).toEqual({ viewer: 0, owner: 1, admin: 2 });
  });

  it.each([
    ['viewer', 'viewer', true],
    ['viewer', 'owner', false],
    ['viewer', 'admin', false],
    ['owner', 'viewer', true],
    ['owner', 'owner', true],
    ['owner', 'admin', false],
    ['admin', 'viewer', true],
    ['admin', 'owner', true],
    ['admin', 'admin', true],
  ] as const)('hasRole(%s, %s) is %s', (actual, required, expected) => {
    expect(hasRole(actual, required)).toBe(expected);
  });

  it('recognises only the role names', () => {
    expect(isRole('owner')).toBe(true);
    for (const value of ['operator', 'Admin', '', 'toString', 1, null]) {
      expect(isRole(value)).toBe(false);
    }
  });
});
