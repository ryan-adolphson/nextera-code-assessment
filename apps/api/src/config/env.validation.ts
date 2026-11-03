import {
  CommonEnvironmentVariables,
  validateEnvironment,
} from '@nextera/shared';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

/** NODE_ENV, DATABASE_URL, DB_POOL_MAX and REDIS_URL are the common ones (`@nextera/shared`). */
export class EnvironmentVariables extends CommonEnvironmentVariables {
  /** Validated by the base class (an integer, 1–65535); Cloud Run sets 8080. */
  override PORT: number = 3000;

  /**
   * Browser origins allowed to call the API (comma-separated): the nextera-web run.app URL and
   * web_domain in production (Terraform), http://localhost:4200 in development. Empty = no cross-origin access.
   */
  @IsString()
  CORS_ORIGINS: string = '';

  /**
   * HS256 signing key of the API's access tokens (Secret Manager `jwt-secret` in GCP, .env locally).
   * At least 32 characters (256 bits); `openssl rand -base64 48` gives 64. No default: the API
   * refuses to start without it (compose passes "" when it's unset). Messages never print the value.
   */
  @IsString({ message: 'JWT_SECRET must be set' })
  @MinLength(32, { message: 'JWT_SECRET must be at least 32 characters' })
  JWT_SECRET: string;

  /** JWT `iss` the API signs and requires. */
  @IsString()
  @IsNotEmpty()
  JWT_ISSUER: string = 'nextera-api';

  /** JWT `aud` the API signs and requires. */
  @IsString()
  @IsNotEmpty()
  JWT_AUDIENCE: string = 'nextera-web';
}

/** Fails fast at startup with every invalid variable listed. */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  return validateEnvironment(EnvironmentVariables, config);
}
