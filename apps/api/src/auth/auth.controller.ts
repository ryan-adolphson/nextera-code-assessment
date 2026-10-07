import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { Public, Roles, CurrentUser } from './auth.decorators.js';
import { AuthService } from './auth.service.js';
import type {
  AuthenticatedUser,
  LoginResponse,
  UserResponse,
} from './auth.types.js';
import { LoginDto } from './dto/login.dto.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** POST /api/auth/login: email + password → a 24-hour access token (401 "Invalid email or password"). */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto): Promise<LoginResponse> {
    return this.auth.login(dto.email, dto.password);
  }

  /** GET /api/auth/me: the signed-in user, with their current role. */
  @Roles('viewer')
  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): UserResponse {
    return { email: user.email, role: user.role };
  }
}
