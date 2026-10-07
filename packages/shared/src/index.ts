// Prisma: generated client, types and enums (import from here, never from bare @prisma/client)
export { Prisma, PrismaClient } from './generated/prisma/client.js';
export type {
  AlertConfig,
  Farm,
  Telemetry,
  TelemetryAlert,
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
  TELEMETRY_ALERTS_INCLUDE,
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
  TelemetryWithAlerts,
  TurbineResponse,
} from './wind/responses.js';

// Alert evaluation (ingestion stores each reading's triggered rules in telemetry_alerts)
export {
  compareAlertsWorstFirst,
  triggeredAlerts,
} from './wind/evaluate-alerts.js';
export type { AlertableReading } from './wind/evaluate-alerts.js';

// Alert thresholds (alerts_config): response shape, mapper and change event
export {
  ALERT_CONFIG_CHANGED,
  toAlertConfigResponse,
} from './wind/alert-config.js';
export type {
  AlertConfigChangedEvent,
  AlertConfigResponse,
} from './wind/alert-config.js';

// Seed data loader (prisma/seed.ts and e2e tests)
export {
  TELEMETRY_CSV_COLUMNS,
  parseCsv,
  seedFromCsv,
} from './seed/seed-from-csv.js';
export type { SeedResult } from './seed/seed-from-csv.js';
