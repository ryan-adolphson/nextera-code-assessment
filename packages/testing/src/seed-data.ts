import { fileURLToPath } from 'node:url';

/** The CSV seed files (farms, turbines, telemetry) owned by the shared package. */
export const SEED_DATA_DIR = fileURLToPath(
  new URL('../../shared/prisma/data', import.meta.url),
);
