import { ROLES, ROLE_RANK, hasRole, isRole } from './roles';

describe('roles (mirror of @nextera/shared)', () => {
  it('has the API role names, lowest first', () => {
    expect(ROLES).toEqual(['viewer', 'owner', 'admin']);
    expect(ROLE_RANK).toEqual({ viewer: 0, owner: 1, admin: 2 });
  });

  it('is hierarchical', () => {
    expect(hasRole('viewer', 'owner')).toBe(false);
    expect(hasRole('owner', 'owner')).toBe(true);
    expect(hasRole('admin', 'owner')).toBe(true);
    expect(hasRole('owner', 'admin')).toBe(false);
    expect(hasRole('viewer', 'viewer')).toBe(true);
  });

  it('recognises only the role names', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('operator')).toBe(false);
    expect(isRole('toString')).toBe(false);
  });
});
