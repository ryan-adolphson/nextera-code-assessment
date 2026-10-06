import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export class EnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3001;

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
