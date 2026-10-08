// Prisma: generated client, types and enums (import from here, never from bare @prisma/client)
export { Prisma, PrismaClient } from './generated/prisma/client.js';
export type {
  AlertConfig,
  Farm,
  Telemetry,
  TelemetryAlert,
  Turbine,
  User,
} from './generated/prisma/client.js';
export {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
  Role,
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
export {
  enabledAlertRules,
  insertTelemetryWithAlerts,
  storeAlerts,
} from './wind/store-telemetry.js';

// Alert thresholds (alerts_config): response shape, mapper and change event
export {
  ALERT_CONFIG_CHANGED,
  toAlertConfigResponse,
} from './wind/alert-config.js';
export type {
  AlertConfigChangedEvent,
  AlertConfigResponse,
} from './wind/alert-config.js';

// Auth: roles (viewer < owner < admin), password hash parameters, email normalisation
export { ROLE_RANK, ROLES, hasRole, isRole } from './auth/roles.js';
export { PASSWORD_HASH_OPTIONS, normalizeEmail } from './auth/passwords.js';

// Seed data loader (prisma/seed.ts and e2e tests)
export {
  TELEMETRY_CSV_COLUMNS,
  parseCsv,
  seedFarmsFromCsv,
  seedFromCsv,
} from './seed/seed-from-csv.js';
export type { SeedResult } from './seed/seed-from-csv.js';
export {
  SEED_PASSWORD_MIN_LENGTH,
  SEED_USERS,
  seedUsers,
} from './seed/seed-users.js';

// Demo data: generated telemetry for the last hours (npm run db:seed:demo, npm run demo:feed)
export {
  DEMO_ALERT_RULES,
  DEMO_SEED,
  DEMO_TURBINES,
} from './seed/demo-fleet.js';
export type { DemoTurbine } from './seed/demo-fleet.js';
export {
  DEMO_ANOMALIES,
  TELEMETRY_STEP_MINUTES,
  floorToTelemetryStep,
  generateTelemetry,
} from './seed/generate-telemetry.js';
export type {
  GenerateTelemetryOptions,
  GeneratedTelemetryRow,
} from './seed/generate-telemetry.js';
export {
  DEMO_SEED_HOURS,
  DEMO_SEED_MAX_HOURS,
  parseDemoSeedEnv,
  seedDemo,
} from './seed/seed-demo.js';
export type { DemoSeedOptions, DemoSeedResult } from './seed/seed-demo.js';
