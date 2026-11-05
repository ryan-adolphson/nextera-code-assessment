import { IsInt, Max, Min } from 'class-validator';
import {
  CommonEnvironmentVariables,
  validateEnvironment,
} from '@nextera/shared';

/** The worker reads only the common variables (`@nextera/shared`), with its own port. */
export class EnvironmentVariables extends CommonEnvironmentVariables {
  /** Validated by the base class (an integer, 1–65535). 3001, next to the API on 3000. */
  override PORT: number = 3001;

  /** Most Pub/Sub readings one flush writes in a single transaction (group commit). */
  @IsInt()
  @Min(1)
  @Max(1000)
  INGEST_BATCH_MAX: number = 100;

  /**
   * Readings that may wait for a flush. Beyond it a push gets 503 + Retry-After at once and
   * nothing is written.
   */
  @IsInt()
  @Min(1)
  @Max(100000)
  INGEST_MAX_QUEUED: number = 500;
}

/** Fails fast at startup with every invalid variable listed. */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  return validateEnvironment(EnvironmentVariables, config);
}
