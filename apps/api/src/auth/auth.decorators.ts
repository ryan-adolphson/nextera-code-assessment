import {
  SetMetadata,
  createParamDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { Role } from '@nextera/shared';
import type { AuthenticatedRequest, AuthenticatedUser } from './auth.types.js';

export const IS_PUBLIC_KEY = 'auth:public';
export const MIN_ROLE_KEY = 'auth:minRole';
export const QUERY_TOKEN_KEY = 'auth:queryToken';

/** No sign-in needed (health probes, login). Every other route requires a valid access token. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * The minimum role for a route (handler, else controller). Roles are hierarchical, so a higher
 * role passes. A too-low role gets 404, as if the route didn't exist. Routes without @Roles
 * (and not @Public) are admin-only, so a forgotten annotation fails closed.
 */
export const Roles = (minRole: Role) => SetMetadata(MIN_ROLE_KEY, minRole);

/**
 * Also accept the token as `?access_token=` (EventSource can't send headers). Only GET /api/events
 * uses it: query strings end up in request logs, so no other route may.
 */
export const AllowQueryToken = () => SetMetadata(QUERY_TOKEN_KEY, true);

/** The signed-in user (set by AuthGuard). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);
