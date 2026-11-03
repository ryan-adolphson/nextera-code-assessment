import {
  CommonEnvironmentVariables,
  validateEnvironment,
} from '@nextera/shared';

/** The worker reads only the common variables (`@nextera/shared`), with its own port. */
export class EnvironmentVariables extends CommonEnvironmentVariables {
  /** Validated by the base class (an integer, 1–65535). 3001, next to the API on 3000. */
  override PORT: number = 3001;
}

/** Fails fast at startup with every invalid variable listed. */
export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  return validateEnvironment(EnvironmentVariables, config);
}
