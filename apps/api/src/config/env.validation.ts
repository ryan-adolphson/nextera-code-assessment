import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  // Local: postgresql://user:pass@localhost:5433/db
  // Cloud Run: postgresql://user:pass@localhost/db?host=/cloudsql/<connection-name>
  @IsString()
  @Matches(/^postgres(ql)?:\/\//, {
    message: 'DATABASE_URL must be a postgresql:// URL',
  })
  DATABASE_URL: string;

  @IsInt()
  @Min(1)
  @Max(100)
  DB_POOL_MAX: number = 5;

  @IsString()
  @Matches(/^rediss?:\/\//, { message: 'REDIS_URL must be a redis:// URL' })
  REDIS_URL: string;

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
  const env = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(env);
  if (errors.length > 0) {
    const details = errors.map(
      (e) =>
        `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
    );
    throw new Error(
      `Invalid environment configuration:\n${details.join('\n')}`,
    );
  }
  return env;
}
