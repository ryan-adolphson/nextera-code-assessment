// Prisma: generated client, types and enums (import from here, never from bare @prisma/client)
export { Prisma, PrismaClient } from './generated/prisma/client.js';
export type {
  AlertConfig,
  Farm,
  Telemetry,
  Turbine,
} from './generated/prisma/client.js';
export {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
} from './generated/prisma/enums.js';
export { PrismaModule } from './prisma/prisma.module.js';
export { PrismaService } from './prisma/prisma.service.js';

// Events (Redis stream + pub/sub) for SSE
export {
  EventStore,
  EventStoreModule,
  EVENT_CHANNEL,
  EVENT_HISTORY_LENGTH,
  EVENT_ID_PATTERN,
  EVENT_STREAM_KEY,
  compareEventIds,
} from './events/event-store.js';
export type { AppEvent } from './events/event-store.js';

// Wind domain: public response shapes (API + SSE) and event names
export {
  TELEMETRY_METRICS,
  TELEMETRY_METRIC_COLUMNS,
  TELEMETRY_RECEIVED,
  toFarmResponse,
  toTelemetryResponse,
  toTelemetryStatsResponse,
  toTurbineResponse,
} from './wind/responses.js';
export type {
  FarmResponse,
  MetricStats,
  TelemetryMetric,
  TelemetryResponse,
  TelemetryStatsResponse,
  TelemetryStatsRow,
  TurbineResponse,
} from './wind/responses.js';

// Seed data loader (prisma/seed.ts and e2e tests)
export {
  TELEMETRY_CSV_COLUMNS,
  parseCsv,
  seedFromCsv,
} from './seed/seed-from-csv.js';
export type { SeedResult } from './seed/seed-from-csv.js';
