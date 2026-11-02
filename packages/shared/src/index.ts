// Prisma: generated client, types and enums (import from here, never from bare @prisma/client)
export { Prisma, PrismaClient } from './generated/prisma/client.js';
export type {
  AlertConfig,
  Farm,
  FarmWeather,
  Telemetry,
  HeldTelemetry,
  TelemetryAlert,
  Turbine,
  UnallocatedTurbine,
  User,
} from './generated/prisma/client.js';
export {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
  Role,
  UnallocatedKind,
  UnallocatedStatus,
} from './generated/prisma/enums.js';
export { PrismaModule } from './prisma/prisma.module.js';
export { PrismaService } from './prisma/prisma.service.js';
export { createPrismaClient } from './prisma/create-prisma.js';

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
  toWeatherDayResponse,
  toWeatherHalfHourResponse,
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
  FarmWeatherResponse,
  TurbineWeatherResponse,
  WeatherDayResponse,
  WeatherDayRow,
  WeatherHalfHourResponse,
  WeatherInterval,
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

// Read queries (API + MCP server): fleet overview, telemetry windows and stats, alerts, reports
export {
  ALERT_RULE_ORDER,
  DEFAULT_TELEMETRY_LIMIT,
  DEFAULT_WEATHER_TIME_ZONE,
  MAX_QUERY_RANGE_DAYS,
  MAX_TELEMETRY_LIMIT,
  QueryError,
  QueryInputError,
  QueryNotFoundError,
  alertsInRange,
  checkTimeZone,
  farmWeather,
  getTurbine,
  getUnallocated,
  heldReadings,
  listAlertRules,
  listUnallocated,
  listFarms,
  parseRange,
  reportSummary,
  reportTelemetry,
  telemetryStats,
  turbineTelemetry,
  turbineWeather,
} from './wind/queries.js';
export type {
  FarmOverview,
  FarmWeatherQuery,
  MetricSummary,
  ReadClient,
  ReportQuery,
  ReportScope,
  TelemetryReport,
  TelemetryReportSummary,
  TelemetryWindow,
  TimeRange,
  TurbineDetail,
  TurbineOverview,
} from './wind/queries.js';

// Farm weather (Open-Meteo minutely_15 → 30-minute farm_weather): client, request planning and the sync
// (`node dist/weather-sync/main.js` in the ingestion image, `npm run weather:sync`)
export {
  HISTORICAL_LAG_DAYS,
  MAX_REQUEST_DAYS,
  OPEN_METEO_ATTEMPTS,
  OPEN_METEO_BACKOFF_MS,
  OPEN_METEO_TIMEOUT_MS,
  OpenMeteoError,
  WEATHER_VARIABLES,
  addDays,
  buildOpenMeteoUrl,
  fetchFarmWeather,
  isUtcDay,
  parseMinutely15,
  planRequests,
  toHalfHourBuckets,
  utcDay,
} from './weather/open-meteo.js';
export type {
  FetchFarmWeatherOptions,
  WeatherAggregate,
  WeatherApi,
  WeatherBucketRow,
  WeatherMetric,
  WeatherRequest,
  WeatherSample,
} from './weather/open-meteo.js';
export {
  WEATHER_REQUEST_DELAY_MS,
  WEATHER_UPSERT_BATCH,
  syncFarmWeather,
  upsertFarmWeather,
} from './weather/sync-weather.js';
export type {
  FarmWeatherSyncResult,
  SyncWeatherOptions,
  SyncWeatherResult,
  WeatherWriteClient,
} from './weather/sync-weather.js';

// Alert thresholds (alerts_config): response shape, mapper and change event
export {
  ALERT_CONFIG_CHANGED,
  toAlertConfigResponse,
} from './wind/alert-config.js';
export type {
  AlertConfigChangedEvent,
  AlertConfigResponse,
} from './wind/alert-config.js';

// Unallocated turbines: ingestion holds readings of unknown turbines and farm mismatches until an
// owner assigns, keeps, moves or blocks them (classify/hold in ingestion, lock/import in the API)
export {
  FLEET_CHANGED,
  HELD_RETENTION_MS,
  MAX_PENDING_UNALLOCATED,
  UNALLOCATED_CHANGED,
  UNALLOCATED_EVENT_INTERVAL_MS,
  UnallocatedCapError,
  blockUnallocated,
  classifyReadings,
  holdReadings,
  importHeld,
  lockTurbineIds,
  lockUnallocated,
  toHeldReadingResponse,
  toUnallocatedResponse,
} from './wind/unallocated.js';
export type {
  FarmRef,
  FleetChangedEvent,
  HeldEntry,
  HeldReadingResponse,
  HoldableReading,
  ImportResult,
  ReadingClass,
  TelemetryRowInput,
  UnallocatedAction,
  UnallocatedChangedEvent,
  UnallocatedListRow,
  UnallocatedResolutionResponse,
  UnallocatedTurbineResponse,
} from './wind/unallocated.js';

// Auth: roles (viewer < owner < admin), password hash parameters, email normalisation
export { ROLE_RANK, ROLES, hasRole, isRole } from './auth/roles.js';
export { PASSWORD_HASH_OPTIONS, normalizeEmail } from './auth/passwords.js';

// Validation: strict ISO 8601 instants (ingestion payloads, API from/to query bounds)
export {
  IsUtcTimestamp,
  MAX_FUTURE_SKEW_MS,
  MIN_TIMESTAMP_MS,
  timestampProblem,
  timestampProblemMessage,
} from './validation/is-utc-timestamp.js';
export type {
  TimestampProblem,
  UtcTimestampOptions,
} from './validation/is-utc-timestamp.js';

// Environment validation: the variables both services read; each service extends the class
export {
  CommonEnvironmentVariables,
  validateEnvironment,
} from './config/env.validation.js';

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
  DEMO_FARM_LAYOUT,
  DEMO_SEED,
  DEMO_TURBINES,
  demoFleetTurbines,
} from './seed/demo-fleet.js';
export type { DemoTurbine } from './seed/demo-fleet.js';
export {
  DEMO_ANOMALIES,
  TELEMETRY_STEP_MINUTES,
  demoReportingLagMinutes,
  floorToTelemetryStep,
  isDemoStopped,
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
export {
  DEMO_UNALLOCATED,
  demoUnallocatedReadings,
  seedDemoUnallocated,
} from './seed/demo-unallocated.js';
export type {
  DemoUnallocatedEntry,
  DemoUnallocatedOutcome,
  DemoUnallocatedResult,
} from './seed/demo-unallocated.js';
