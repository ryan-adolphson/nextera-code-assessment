import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService, normalizeEmail } from '@nextera/shared';
import type { LoginResponse } from './auth.types.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/** The one message for every failed sign-in: never says whether the email exists. */
export const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Checks the email and password and returns a 24-hour access token. Unknown emails, wrong
   * passwords and inactive users all get the same 401 after the same hashing work.
   */
  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.prisma.user.findUnique({
      where: { email: normalizeEmail(email) },
    });
    const valid = user
      ? await this.passwords.verify(user.passwordHash, password)
      : await this.passwords.verifyDummy(password);
    if (!user || !valid || !user.active) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const { token, expiresAt } = await this.tokens.sign(user);
    return {
      accessToken: token,
      expiresAt: expiresAt.toISOString(),
      user: { email: user.email, role: user.role },
    };
  }
}
