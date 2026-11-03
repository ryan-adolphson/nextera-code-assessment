import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Ip,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Public, Roles, CurrentUser } from './auth.decorators.js';
import { AuthService, LoginRateLimitedException } from './auth.service.js';
import type {
  AuthenticatedUser,
  LoginResponse,
  UserResponse,
} from './auth.types.js';
import { LoginDto } from './dto/login.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * POST /api/auth/login: email + password → a 24-hour access token (401 "Invalid email or
   * password"; 429 + `Retry-After` when over a login attempt limit).
   */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    try {
      return await this.auth.login(dto.email, dto.password, ip);
    } catch (error) {
      if (error instanceof LoginRateLimitedException) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      throw error;
    }
  }

  /** GET /api/auth/me: the signed-in user, with their current role. */
  @Roles('viewer')
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): UserResponse {
    return { email: user.email, role: user.role };
  }
}
