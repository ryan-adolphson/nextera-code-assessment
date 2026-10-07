import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isRole, type Role } from '@nextera/shared';
import { SignJWT, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';

/** Access tokens live 24 hours (MVP: no refresh tokens). The web app then asks for a new sign-in. */
export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** Only HS256 is accepted on verify: never `none`, never an algorithm the token's header picks. */
export const JWT_ALGORITHM = 'HS256';
const CLOCK_TOLERANCE_SECONDS = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessTokenClaims {
  /** The user's id (never the email). */
  sub: string;
  role: Role;
  /** Expiry, in seconds since the epoch. */
  exp: number;
}

export interface SignedToken {
  token: string;
  expiresAt: Date;
}

/**
 * Signs and verifies the API's access tokens (JWS, HS256, `jose`): `sub`, `role`, `iss`, `aud`,
 * `iat`, `exp`, `jti`. A signed JWT is readable by anyone, so it carries nothing secret.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(config: ConfigService) {
    this.key = new TextEncoder().encode(
      config.getOrThrow<string>('JWT_SECRET'),
    );
    this.issuer = config.getOrThrow<string>('JWT_ISSUER');
    this.audience = config.getOrThrow<string>('JWT_AUDIENCE');
  }

  async sign(
    user: { id: string; role: Role },
    now: Date = new Date(),
  ): Promise<SignedToken> {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: JWT_ALGORITHM, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setSubject(user.id)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(randomUUID())
      .sign(this.key);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  /**
   * The token's claims, or null for anything that isn't a valid, unexpired token of ours (bad
   * signature, other algorithm, wrong issuer/audience, expired, missing or malformed claims).
   * Callers answer null with a generic 401: which check failed is never disclosed.
   */
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [JWT_ALGORITHM],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['sub', 'exp', 'iat'],
      });
      const { sub, role, exp } = payload;
      if (typeof sub !== 'string' || !UUID.test(sub) || !isRole(role)) {
        return null;
      }
      return { sub, role, exp: exp! };
    } catch {
      return null;
    }
  }
}
