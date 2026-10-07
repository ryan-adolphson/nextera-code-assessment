import type { Role } from '@nextera/shared';
import type { Request } from 'express';

/** The signed-in user the AuthGuard attaches to the request (`@CurrentUser()`). */
export interface AuthenticatedUser {
  id: string;
  email: string;
  /** The user's role as it is now in the database (not just the token's claim). */
  role: Role;
  /** When the access token that authenticated this request expires. */
  expiresAt: Date;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/** POST /api/auth/login response. */
export interface LoginResponse {
  accessToken: string;
  /** ISO 8601; the web app signs out at this time. */
  expiresAt: string;
  user: UserResponse;
}

/** GET /api/auth/me and the `user` of a login. */
export interface UserResponse {
  email: string;
  role: Role;
}
