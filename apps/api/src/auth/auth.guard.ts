import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '@nextera/shared';
import type { Response } from 'express';
import { IS_PUBLIC_KEY, QUERY_TOKEN_KEY } from './auth.decorators.js';
import type { AuthenticatedRequest } from './auth.types.js';
import { TokenService } from './token.service.js';

/**
 * Global guard (APP_GUARD, default deny): every route needs a valid access token unless it is
 * @Public(). The token comes from `Authorization: Bearer …`, or `?access_token=` on routes marked
 * @AllowQueryToken() (only GET /api/events). It then reloads the user (one primary-key query), so a
 * deactivated user is locked out and a role change applies on the next request, not after 24 h.
 * Every failure is the same 401 with `WWW-Authenticate: Bearer`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const allowQuery =
      request.method === 'GET' &&
      this.reflector.getAllAndOverride<boolean>(QUERY_TOKEN_KEY, targets);

    const token =
      bearerToken(request) ?? (allowQuery ? queryToken(request) : undefined);
    const claims = token ? await this.tokens.verify(token) : null;
    const user = claims
      ? await this.prisma.user.findUnique({
          where: { id: claims.sub },
          select: { id: true, email: true, role: true, active: true },
        })
      : null;
    if (!claims || !user?.active) {
      http.getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException();
    }

    request.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      expiresAt: new Date(claims.exp * 1000),
    };
    return true;
  }
}

function bearerToken(request: AuthenticatedRequest): string | undefined {
  const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

function queryToken(request: AuthenticatedRequest): string | undefined {
  const value: unknown = request.query?.access_token;
  return typeof value === 'string' && value ? value : undefined;
}
