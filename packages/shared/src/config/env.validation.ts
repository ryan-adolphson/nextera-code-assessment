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

/**
 * The environment variables the API and the ingestion worker both read. Each service extends
 * this with its own variables and its `PORT` default (there is none here, so a service that
 * forgets one fails at startup instead of both listening on the same port).
 */
export class CommonEnvironmentVariables {
  @IsIn(['development', 'test', 'production'])
  NODE_ENV: 'development' | 'test' | 'production' = 'development';

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number;

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

/**
 * Validates `config` against a service's environment class (numeric strings are converted).
 * Fails fast at startup with every invalid variable listed.
 */
export function validateEnvironment<T extends CommonEnvironmentVariables>(
  variables: new () => T,
  config: Record<string, unknown>,
): T {
  const env = plainToInstance(variables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(env);
  if (errors.length > 0) {
    // class-validator reports a subclass's own properties before the inherited ones. List them
    // in declaration order instead (common variables first), as the instance's fields are.
    const declared = Object.keys(env);
    const position = (property: string) => {
      const index = declared.indexOf(property);
      return index === -1 ? declared.length : index;
    };
    errors.sort((a, b) => position(a.property) - position(b.property));
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
