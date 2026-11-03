import {
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService, normalizeEmail } from '@nextera/shared';
import type { LoginResponse } from './auth.types.js';
import { LoginLimiterService } from './login-limiter.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/** The one message for every failed sign-in: never says whether the email exists. */
export const INVALID_CREDENTIALS = 'Invalid email or password';

/** A 429; the controller turns `retryAfterSeconds` into the `Retry-After` header. */
export class LoginRateLimitedException extends HttpException {
  constructor(readonly retryAfterSeconds: number) {
    super('Too many attempts', HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly limiter: LoginLimiterService,
  ) {}

  /**
   * Checks the email and password and returns a 24-hour access token. Unknown emails, wrong
   * passwords and inactive users all get the same 401 after the same hashing work. An attempt over
   * a limit gets 429 before any lookup or hashing, whatever its password and whether or not the
   * email exists.
   */
  async login(
    email: string,
    password: string,
    ip: string,
  ): Promise<LoginResponse> {
    const reservation = await this.limiter.reserve(email, ip);
    if (reservation.limited) {
      throw new LoginRateLimitedException(reservation.retryAfterSeconds);
    }

    let user;
    let valid;
    try {
      user = await this.prisma.user.findUnique({
        where: { email: normalizeEmail(email) },
      });
      valid = user
        ? await this.passwords.verify(user.passwordHash, password)
        : await this.passwords.verifyDummy(password);
    } catch (error) {
      await reservation.cancel(); // no answer on the password, so not a failed attempt
      throw error;
    }
    if (!user || !valid || !user.active) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }
    await reservation.succeeded();

    const { token, expiresAt } = await this.tokens.sign(user);
    return {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      user: { email: user.email, role: user.role },
    };
  }
}
