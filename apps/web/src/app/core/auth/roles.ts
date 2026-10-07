/**
 * Mirrors `Role`, `ROLE_RANK` and `hasRole` from @nextera/shared by hand (this app can't import
 * it; roles.spec.ts pins the names). Roles are hierarchical: viewer < owner < admin.
 * The API is the authority: it checks the role on every request; the UI only hides controls.
 */
export type Role = 'viewer' | 'owner' | 'admin';

export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, owner: 1, admin: 2 };

/** Every role, lowest first. */
export const ROLES: readonly Role[] = ['viewer', 'owner', 'admin'];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  viewer: 'Viewer',
  owner: 'Owner',
  admin: 'Admin',
};

/** Whether `actual` is at least `required`. */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.hasOwn(ROLE_RANK, value);
}
