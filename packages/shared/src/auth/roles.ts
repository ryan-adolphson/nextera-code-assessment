import { Role } from '../generated/prisma/enums.js';

/**
 * Roles are hierarchical: a route declares the minimum role and every higher role passes.
 * apps/web mirrors this by hand in core/auth/roles.ts (it can't import @nextera/shared).
 */
export const ROLE_RANK: Readonly<Record<Role, number>> = {
  [Role.viewer]: 0,
  [Role.owner]: 1,
  [Role.admin]: 2,
};

/** Every role, lowest first. */
export const ROLES: readonly Role[] = Object.values(Role).sort(
  (a, b) => ROLE_RANK[a] - ROLE_RANK[b],
);

/** Whether `actual` is at least `required` (owner passes a viewer route, not an admin one). */
export function hasRole(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.hasOwn(ROLE_RANK, value);
}
