import {
  Injectable,
  NotFoundException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { hasRole, type Role } from '@nextera/shared';
import { IS_PUBLIC_KEY, MIN_ROLE_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';

/** Routes without @Roles (and not @Public) need this role, so a forgotten annotation fails closed. */
export const DEFAULT_MIN_ROLE: Role = 'admin';

/**
 * Global guard after AuthGuard: the user's role must be at least the route's @Roles (handler, then
 * controller). A too-low role gets exactly the 404 of a route that doesn't exist ("Cannot GET /…"),
 * so the API doesn't reveal what a viewer can't use.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const required =
      this.reflector.getAllAndOverride<Role | undefined>(
        MIN_ROLE_KEY,
        targets,
      ) ?? DEFAULT_MIN_ROLE;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user && hasRole(request.user.role, required)) {
      return true;
    }
    // Same message as Nest's not-found handler (method + original URL).
    throw new NotFoundException(
      `Cannot ${request.method} ${request.originalUrl}`,
    );
  }
}
