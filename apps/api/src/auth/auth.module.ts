import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginLimiterService } from './login-limiter.service.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

/** Sign-in and access tokens. The guards are registered globally in AppModule (APP_GUARD). */
@Module({
  controllers: [AuthController],
  providers: [AuthService, LoginLimiterService, PasswordService, TokenService],
  exports: [TokenService],
})
export class AuthModule {}
