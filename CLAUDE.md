# CLAUDE.md

This file guides Claude Code when working in this repository.

## Project overview

Take-home exercise: **wind-farm fleet monitoring**. Turbine telemetry (power, wind, rotor speed, blade pitch, gearbox temperature, every 5 minutes) is ingested from **Pub/Sub** by a **NestJS ingestion worker**, stored in **PostgreSQL** with **Prisma**, and streamed live over **Server-Sent Events** by a **NestJS API & SSE service** to an **Angular** app. The services and the app (nginx) run on **Google Cloud Run**, and the infrastructure is defined with **Terraform**. Local development mirrors it with **docker-compose**.

```
turbines → Pub/Sub "telemetry" ─push→ Ingestion Worker ─→ Postgres + Redis ─→ API & SSE ←─ Angular (Cloud Run, nginx)
                 └─ dead-letter topic after N failed deliveries                 (REST + SSE, CORS, own domain)
```

## Specialist agents

Ten subagents in `.claude/agents/` hold the patterns to follow and the gotchas already hit. Use them for work in their area:
- **`angular-engineer`** ([.claude/agents/angular-engineer.md](.claude/agents/angular-engineer.md)): anything in `apps/web` (pages, Material, Tailwind, charts, maps, `FleetStore`, the web image, Angular tests). Preloads the `angular-developer` skill.
- **`nestjs-engineer`** ([.claude/agents/nestjs-engineer.md](.claude/agents/nestjs-engineer.md)): `apps/api`, `apps/ingestion` and `packages/shared` (endpoints, DTOs, Prisma and migrations, ingestion, `EventStore`/SSE, the service images, backend tests). Preloads the `nestjs-professional-software-engineering`, `nestjs-features-performance` and `zod` skills.
- **`fullstack-architect`** ([.claude/agents/fullstack-architect.md](.claude/agents/fullstack-architect.md)): architecture, changes that span the backend and the web app (API/SSE contracts, the data model end to end), docker-compose, Cloud Run, Terraform, and the GCP side of CI/CD (WIF, deployer SA). Preloads the `terraform-style-guide`, `terraform-test`, `cloud-run-basics` and `zod` skills.
- **`angular-material-engineer`** ([.claude/agents/angular-material-engineer.md](.claude/agents/angular-material-engineer.md)): all Material/CDK UI in `apps/web` (form fields, selects, autocomplete, datepickers, buttons and toggles, chips, tables and paginators, dialogs, tooltips, routed section tabs (PageTabs), icons), the `--mat-*` token mapping in `styles.css`, UI accessibility and Material harness specs. Preloads the `angular-material` and `angular-developer` skills. **Routing:** any UI build or change goes to it; for a feature with logic and UI, `angular-engineer` goes first (logic, state, data, a working template), then `angular-material-engineer` finishes the UI. They run in sequence on shared files, in parallel only when the files don't overlap.
- **`auth-engineer`** ([.claude/agents/auth-engineer.md](.claude/agents/auth-engineer.md)): authentication and authorization end to end (JWT access tokens, login/logout, password hashing, NestJS guards and `@Roles` with viewer < owner < admin, the Angular login page, interceptor and route guards, SSE auth, the `users` model, signing keys). Preloads the `nestjs-features-performance`, `nestjs-professional-software-engineering` and `angular-developer` skills.
- **`cicd-engineer`** ([.claude/agents/cicd-engineer.md](.claude/agents/cicd-engineer.md)): CI/CD: the GitHub Actions workflows (`ci.yml`, `deploy.yml`), their jobs, permissions, concurrency and caching, the deploy pipeline, repository variables and the `production` environment, workflow security and efficiency reviews. The GCP side (WIF, deployer SA, `github.tf`) stays with `fullstack-architect`. Preloads the `github-actions-hardening` and `github-actions-efficiency` skills.
- **`web-test-engineer`** ([.claude/agents/web-test-engineer.md](.claude/agents/web-test-engineer.md)): front-end testing: Angular unit tests (Vitest + TestBed, harnesses, resources), SSE testing (`FakeEventSource`, `fakes().sse`, `FleetStore` reconnect/backoff/resync), coverage toward 100% behind the threshold ratchet, and Playwright browser E2E in `e2e/` (with the `playwright-test` MCP tools). Production code stays with `angular-engineer`. Preloads the `angular-developer` and `playwright-cli` skills.
- **`playwright-test-planner`**, **`playwright-test-generator`**, **`playwright-test-healer`** (Playwright's own generated agents; don't edit them): the planner explores the app and writes plans to `e2e/specs/*.md`, the generator turns plan scenarios into `e2e/tests/**`, the healer debugs and fixes failing tests. They need the `playwright-test` MCP server (`.mcp.json`) and the running compose stack + `db:seed` fixture (see **Tests**).

**Parallel work:** run agents in parallel when their pieces are independent, for example backend + Terraform + workflow, or backend + web once the API contract is settled. Fix the shared names (routes, response shapes, env vars, job names, variables) in every prompt, and say which areas the other agents own. Run them in order only when one needs another's output.

**Skills:** installed with `npx skills` into `.agents/skills/` (pinned in `skills-lock.json`) and symlinked into `.claude/skills/`, where Claude Code discovers them. After `npx skills add`, symlink any new skill the same way. `zod` (Zod 4 for the MCP tool schemas) and `angular-material` (Material 22.2 / CDK reference + this repo's Material conventions; preloaded by angular-engineer, angular-material-engineer and web-test-engineer) are repo-local: written here, committed with the code and not in the lock. The agent files take precedence over the general skill guidance (e.g. no component CSS, Cloud Run + Pub/Sub push).

## Layout

```
apps/
  api/                  # @nextera/api        NestJS 12: GET /api/farms, GET /api/turbines/:id/telemetry,
                        #                     GET /api/turbines/:id/telemetry/stats (median/high/low per metric over the same rows),
                        #                     PATCH /api/turbines/:id { commissioned: boolean } (owner; the updated turbine, fleet.changed if the value changed),
                        #                     GET /api/farms/:farmId/weather and GET /api/turbines/:id/weather (the turbine's farm)
                        #                     ?from=&to=&interval=30min|daily&timeZone= (Open-Meteo, ≤ 31 days),
                        #                     GET /api/farms/:farmId/telemetry/daily?from=&to=&timeZone= (daily candles of the farm series
                        #                     from the 30-minute farm rollups, ≤ 183 days; ETag/304, Cache-Control: private, no-cache),
                        #                     CRUD /api/alert-configs (alert thresholds; writes need owner),
                        #                     GET /api/alerts?from=&to= (flagged readings + their rules, by turbine; ≤ 31 days),
                        #                     GET /api/reports/telemetry?farmId=|turbineId=&from=&to= (all readings + alerts; ≤ 31 days),
                        #                     /api/unallocated-turbines (owner: list ?status=pending|blocked, :id/readings,
                        #                     POST :id/assign|keep|move|block|unblock),
                        #                     SSE GET /api/events; POST /api/auth/login, GET /api/auth/me (sign-in, roles);
                        #                     CORS for the web app. Dockerfile -> image "api"
  ingestion/            # @nextera/ingestion  NestJS 12: Pub/Sub push POST /pubsub/telemetry,
                        #                     CSV upload POST /ingest/telemetry (multipart field "file"). Dockerfile -> image "ingestion"
    src/demo-feed/      #   live demo feed, not part of the worker: `node dist/demo-feed/main.js [--once]` in the same image
    src/farm-rollup/    #   farm rollup job, not part of the worker: `node dist/farm-rollup/main.js [--full | --from YYYY-MM-DD] [--every <s>]`
    src/weather-sync/   #   Open-Meteo sync, not part of the worker: `node dist/weather-sync/main.js [--from --to --farm]`, same image
    scripts/            #   publish-sample.ts (npm run ingest:publish), demo-feed.ts (npm run demo:feed), weather-sync.ts (npm run weather:sync)
  mcp/                  # @nextera/mcp       Local stdio MCP server (plain Node, @modelcontextprotocol/sdk), read-only fleet tools
                        #                     for Claude: list_farms, get_turbine, get_telemetry, get_telemetry_stats,
                        #                     list_alerts, list_alert_rules, get_report_summary, get_weather, list_unallocated,
                        #                     get_unallocated_readings. Registered in .mcp.json; no image
  web/                  # Angular 22 app (separate npm project, NOT a workspace). Dockerfile (context apps/web) -> image "web":
                        #                     nginx + runtime /config.json (docker/: nginx template, API_BASE_URL check + tests)
packages/
  shared/               # @nextera/shared     Prisma schema + migrations, CSV seed data, PrismaService, EventStore, mappers,
                        #                     read queries (src/wind/queries.ts: used by the API and the MCP server),
                        #                     demo data (src/seed: demo fleet + telemetry generator; prisma/seed-demo.ts);
                        #                     farm weather (src/weather: Open-Meteo client + syncFarmWeather);
                        #                     Dockerfile = migration runner for local compose only
  testing/              # @nextera/testing    Testcontainers global setup for e2e tests
e2e/                    # Playwright browser E2E (separate npm project, NOT a workspace) against the compose stack (web :8082):
                        #   playwright.config.ts (projects read-only + data), tests/seed.spec.ts (fixed clock + sign-in;
                        #   the agents' seed), tests/data/** ([DATA] tests, serial), specs/*.md (test plans)
infra/terraform/        # Cloud Run (api, ingestion, web), Pub/Sub + DLQ, Cloud SQL, Memorystore, Secret Manager,
                        # Artifact Registry, domain mappings, GitHub Actions WIF + deployer SA,
                        # farm rollup (farm-rollup.tf: Cloud Run Job + Cloud Scheduler every 15 min, farm_rollup_enabled, on by default),
                        # optional demo feed (demo-feed.tf: Cloud Run Job + Cloud Scheduler, demo_feed_enabled),
                        # optional weather sync (weather-sync.tf: Cloud Run Job + daily Cloud Scheduler, weather_sync_enabled),
                        # Cloud Monitoring (monitoring.tf: uptime checks, alert policies incl. failed job executions, optional budget),
                        # tests/*.tftest.hcl (terraform test, mock providers only: offline, nothing created)
.github/workflows/      # ci.yml (checks + browser E2E on PRs + main), deploy.yml (main: images -> migrate -> Cloud Run [-> demo feed job] [-> weather sync job] [-> farm rollup job])
docker-compose.yml      # postgres, redis, pubsub emulator (+ init), migrate, api, ingestion, web, demo-feed, farm-rollup
.env.example            # copy to .env: the ONE env file for compose, both services, Prisma and scripts
.mcp.json               # MCP servers for Claude Code: playwright-test (e2e agents) and nextera (apps/mcp, read-only fleet tools)
```

The repo root is an **npm workspace** (`packages/*`, `apps/api`, `apps/ingestion`, `apps/mcp`). Install from the root. `apps/web` has its own `package.json`, because Angular and NestJS 12 need different TypeScript versions.

## Environments

| | Local | GCP |
|---|---|---|
| Database | compose `nextera-postgres` (host `localhost:5433`) | Cloud SQL PostgreSQL 18 |
| Redis (SSE history + fan-out) | compose `nextera-redis` (host `localhost:6380`; password `REDIS_PASSWORD`, default `nextera-local`, also in `REDIS_URL`) | Memorystore (AUTH) |
| Pub/Sub | compose emulator `localhost:8085`, topic `telemetry` → push to ingestion | topic `telemetry`, push subscription (OIDC) + `telemetry-dead-letter` |
| Ingestion worker | `npm run dev:ingestion` (:3001) or compose (:8081) | Cloud Run `nextera-ingestion` (IAM-only) |
| API & SSE | `npm run dev:api` (:3000) or compose (:8080) | Cloud Run `nextera-api`, `api_domain` |
| Angular | `cd apps/web && npm start` (:4200 → API on :3000), `npm run start:docker` (→ compose API on :8080), or compose `web` (:8082) | Cloud Run `nextera-web` (public; `web_url` output, `web_domain`) |
| Demo feed (off by default) | `npm run demo:feed` or compose `demo-feed`, both on `DEMO_FEED_ENABLED=true` in `.env` | Cloud Run Job `nextera-demo-feed` + Cloud Scheduler every 5 min (`demo_feed_enabled`, `demo_feed_paused`) |
| Migrations | `npm run db:migrate` / compose `migrate` | GitHub Actions `deploy.yml`: `prisma migrate deploy` via Cloud SQL Auth Proxy, before each deploy |
| CI/CD | `npm run lint && …` (see below) | GitHub Actions (`ci.yml`, `deploy.yml`), Workload Identity Federation, `production` environment |
| Farm rollup (History tab) | compose `farm-rollup` (`--every 900`), or `npm run rollup` / `npm run rollup:watch`; `db:seed`, `db:seed:demo` and `demo:reset` run one | Cloud Run Job `nextera-farm-rollup` + Cloud Scheduler every 15 min (`farm_rollup_enabled`, default true; `farm_rollup_paused`, `farm_rollup_schedule`) |
| Weather sync (Open-Meteo) | `npm run weather:sync` (default: last 7 UTC days, all farms; `-- --from YYYY-MM-DD --to YYYY-MM-DD --farm FARM01`) | Cloud Run Job `nextera-weather-sync` + Cloud Scheduler daily 01:30 UTC (`weather_sync_enabled`, `weather_sync_paused`, `weather_sync_schedule`) |
| Secrets | `.env` (gitignored) | Secret Manager (`database-url`, `redis-url`, `jwt-secret`; optional `open-meteo-api-key`) |

There is exactly one local database (the compose Postgres) and one Prisma schema (`packages/shared`). Keep Postgres 18 in step with Cloud SQL (`db_version`).

## Conventions

- **TypeScript:** `strict` everywhere. NestJS 12 services are ESM, so relative imports end in `.js`.
- **Shared code:** both services import Prisma, `EventStore`, the `to*Response` mappers and the event names from `@nextera/shared`; the API and the MCP server read through the shared queries (`src/wind/queries.ts`: `listFarms`, `turbineTelemetry`, `telemetryStats`, `alertsInRange`, `reportTelemetry`, …), which throw `QueryNotFoundError`/`QueryInputError` that the API maps to 404/400; ingestion and the demo seed store readings with `insertTelemetryWithAlerts` / `storeAlerts` / `enabledAlertRules`; the demo seed and feed share `DEMO_TURBINES`, `DEMO_SEED`, `DEMO_ANOMALIES` and `generateTelemetry` (deterministic, so the feed continues the seeded curve). Never duplicate them.
- **Data:** Prisma only. Migrations must be backward-compatible with the running revision (one accepted exception: `20261006233000_turbines_uuid_id_commissioned`), are committed, and are applied only by `migrate deploy`. Write column renames by hand (`RENAME COLUMN`): `migrate dev`/`migrate diff` would drop and re-add the column.
- **Events:** publish to Redis via `EventStore` only **after** the database transaction commits.
- **Data model:** `farms` → `turbines` → `telemetry`. `turbines`: UUID `id` (internal, never exposed by the API), business key `turbine_id` ('TURB001', unique; used by payloads, CSVs, API ids, SSE and URLs), `commissioned` (default false). `telemetry`: UUID id; composite FK `(turbine_id, farm_id)` → `turbines(turbine_id, farm_id)`; unique `(turbine_id, timestamp)`. `created_at` (default now(), set by Postgres) is the real insert time; `received_at` can come from the payload/CSV for backfills; neither `created_at` nor the internal ids are in API responses. "Latest" and trends use the measurement `timestamp`, never `received_at` or `created_at`. Aggregates such as `/telemetry/stats` are computed in Postgres over exactly the rows the matching list endpoint returns. `alerts_config` holds alert thresholds: `measurement_metric` (enum of the telemetry metric columns), `comparison` (`above`/`below`), `value_metric`, `alert_level` (`info`/`warn`/`error`), `enabled` (default true; disabled rules are kept but not evaluated); one rule per (metric, comparison, level). `telemetry_alerts` (PK `(telemetry_id, alert_id)`): the rules each reading triggered, a join table (not an array column) so both ids are real FKs; `telemetry_id` CASCADE, `alert_id` RESTRICT (Postgres 23001, Prisma P2003): `DELETE /api/alert-configs/:id` of a rule that readings triggered returns 409, disable it instead (`PATCH {enabled: false}`). Ingestion (Pub/Sub and CSV) evaluates the enabled rules in the insert's transaction with `triggeredAlerts` (`@nextera/shared`, strict `>`/`<`); reads `include: TELEMETRY_ALERTS_INCLUDE`, and `TelemetryResponse.alerts` (API + SSE) is the joined rules as they are now (no snapshot), worst level first. No backfill: older readings have none. `users`: UUID `id` (the JWT `sub`), unique normalised (trimmed, lower-case) `email`, `password_hash` (argon2id), `role` (enum `role`: `viewer`/`owner`/`admin`), `active` (default true), `created_at`, `updated_at`; rows come only from `npm run db:seed` (or `db:seed:demo`). `unallocated_turbines`: UUID `id` (exposed: the API's actions need it), `turbine_id`, `reported_farm_id` (no FK: the farm may not exist), `kind` (`unknown_turbine`/`farm_mismatch`; the API derives it live), `status` (`pending`/`blocked`), `first_seen_at`/`last_seen_at` (server receive times), `blocked_at`, `blocked_by` (→ `users`, SET NULL); unique `(turbine_id, reported_farm_id)`. `held_telemetry`: readings waiting for a decision (the telemetry columns + `unallocated_id`, CASCADE), unique `(unallocated_id, timestamp)`. Unblock deletes the entry (the pair's next reading starts a new one). UUID ids are generated by Postgres (`gen_random_uuid()`).
- **Demo data:** `npm run db:seed` stays the fixed fixture (the CSVs: TURB001/TURB002, 2 days in Jan 2026) that tests rely on. `npm run db:seed:demo` is for demos: the fixture farms, 200 `DEMO_TURBINES` (TURB001–TURB200, 16–24 per farm: TURB001–TURB025 hand-placed as before, TURB026–TURB200 generated by `demoFleetTurbines()` from `DEMO_FARM_LAYOUT`, a contiguous id block per farm on a staggered grid within 3 km of the farm centre; ids ending in 7 uncommissioned), the default rules (gearbox > 100 °C error, power < 100 kW warn, pitch > 30° info; existing rules kept), 72 h of generated telemetry ending now with `telemetry_alerts`, and the test users. Idempotent: a re-run tops up to now (`SEED_NOW` ISO, `SEED_HOURS` 1–744 override). The seed generates 10 turbines at a time and inserts 5,000-reading transactions with `insertTelemetryBulk` (flagged readings via `insertTelemetryWithAlerts`, the rest via one `unnest` insert): 72 h ≈ 7 s, `demo:reset`'s 168 h (~403k readings) ≈ 17 s. Anomalies, relative to the seed's end: TURB001 frozen at 0 kW in strong wind (−50 h), TURB002 pitch spike (−30 h) and gearbox stuck at 126.5 °C (−6 h), 20 stale turbines (10 %, on every farm, none with another anomaly): 6 stopped (`DEMO_ANOMALIES.stopped`: TURB013 −90 min, TURB053 −2 h, TURB091 −2.5 h, TURB139 −3 h, TURB160 −4 h, TURB195 −5 h; "No data in 60 min", red; the feed never publishes them), 14 lagging (`DEMO_ANOMALIES.lagging`: TURB011/030/047/063/102/117/152/186 20 min behind, "No data in 15 min", yellow; TURB018/036/070/085/124/173 45 min behind, "No data in 30 min", orange; the seed ends them at end − lag and each feed tick publishes their reading for the 5-min boundary at `floor(now) − lag` from `generateTelemetry`, so their pills stay put; `demoReportingLagMinutes` is the one rule for both), TURB008 gap (−20 h), late `received_at` on TURB005/014/021, and TURB999 claiming FARM01 (outside the fleet's TURB001–TURB200; the feed publishes it every tick, so it shows under Unallocated). **Unallocated entries** (`DEMO_UNALLOCATED`, `src/seed/demo-unallocated.ts`, held readings from `generateTelemetry` ending at the seed's end):
  - Pending:
    - TURB999→FARM01, unknown, 6 h;
    - TURB998→FARM99, unknown, farm doesn't exist, 3 h;
    - TURB003→FARM02, mismatch (it's on FARM01), 2 h;
    - TURB004→FARM99, mismatch, Move disabled, 1 h.
  - Blocked:
    - TURB997→FARM05, unknown, by admin@, end − 24 h;
    - TURB005→FARM03, mismatch, by owner@, end − 12 h.

  Written through the shared `classifyReadings`/`holdReadings`/`blockUnallocated`, like ingestion and the API. A re-run:
  - tops up pending entries;
  - never unblocks, and never blocks a pending entry;
  - skips a pair whose turbine is now on the reported farm (assigned or moved);
  - re-creates a kept or unblocked pair, as its next real reading would.

  A demo turbine's farm is set only when it's created, so a re-run doesn't undo a Move. The live feed (`apps/ingestion/src/demo-feed`) publishes one reading per demo turbine (194: not the 6 stopped ones; the lagging ones at their lag) plus TURB999 per tick (195 publishes) at the current 5-min boundary to `PUBSUB_TOPIC`, through Pub/Sub → ingestion like a real turbine (alerts, SSE). Env only: `DEMO_FEED_ENABLED` (must be `true`, else it logs "Demo feed disabled" and exits 0), `DEMO_FEED_INTERVAL_SECONDS` (300), `--once`/`DEMO_FEED_ONCE=true`; no DB, Redis or JWT. **Run `db:seed:demo` before enabling the feed:** the fixture has only TURB001/TURB002, readings for unknown turbines get 400, and the emulator (no DLQ) redelivers them forever (GCP: DLQ after `pubsub_max_delivery_attempts`). `npm run demo:reset` (`packages/shared/prisma/demo-reset.ts`) gives a fresh demo in one command: it refuses unless `DATABASE_URL` is localhost or the compose Postgres (`--allow-remote`) and asks for confirmation (`--yes`), deletes `telemetry_alerts`, `telemetry`, `held_telemetry`, `unallocated_turbines`, `farm_weather` and the farm rollup tables in one transaction (farms, turbines, users and rules stay, so a move stays), re-seeds 168 h up to now, syncs the weather (a failure is a warning), publishes one feed tick and (re)starts the compose `demo-feed` with `DEMO_FEED_ENABLED=true` as a shell override (rebuilding its image unless `--no-build`), or prints `DEMO_FEED_ENABLED=true npm run demo:feed` without the stack. `--no-weather` and `--no-feed` skip those steps.
- **Farm weather (Open-Meteo):** one 30-minute series per farm (farm coordinates; a turbine has none of its own and uses its current farm's) in `farm_weather`: PK `(farm_id, time)` (start of the 30-minute UTC bucket, :00/:30), FK `farms` CASCADE, `samples` (15-minute values in the bucket, 1–2), nullable `wind_speed_10m_ms`, `wind_speed_80m_ms`, `wind_direction_10m_deg`, `wind_direction_80m_deg`, `wind_gusts_10m_ms`, `temperature_2m_c`, `relative_humidity_2m_pct`, `surface_pressure_hpa`, `precipitation_mm`, `cloud_cover_pct`, `fetched_at`. Source: the forecast models' `minutely_15` only (native HRRR in North America, ICON-D2/AROME in Central Europe, interpolated hourly elsewhere): `syncFarmWeather` (`packages/shared/src/weather`) reads days older than `HISTORICAL_LAG_DAYS` (5) from the Historical Forecast API (`historical-forecast-api.open-meteo.com/v1/forecast`, from ~2022; chunks ≤ 92 days) and recent days from the Forecast API (`start_date`/`end_date`, `timezone=UTC`, `wind_speed_unit=ms`; retries 429/5xx/timeouts 3×, 15 s timeout, requests one at a time). `toHalfHourBuckets` aggregates each :00+:15 / :30+:45 pair (speeds, temperature, humidity, pressure, cloud: mean; gusts: max; precipitation: sum; directions: vector mean), drops buckets without any value, and `upsertFarmWeather` overwrites (the newer fetch wins; no archive/ERA5). Today's rows run to 23:30 UTC (forecast), so "latest" means the newest bucket that has started. One farm failing doesn't stop the others; the runner exits 1 if any failed. Daily figures are never stored: `farmWeather` / `turbineWeather` (`queries.ts`, `interval=daily`) aggregate per local day in `timeZone` (IANA, default `UTC`, checked against `pg_timezone_names`, bound never interpolated; unknown → 400) in Postgres (wind means/maxes, gust max, vector-mean 80 m direction, temperature min/max/mean, precipitation sum, `samples` = buckets: 48, 46/50 on a DST day); `30min` returns the buckets (UTC times; `timeZone` only echoed). Both endpoints return `{ farmId, [turbineId], from, to, interval, timeZone, points }`; `turbineWeather` 404s an unknown turbine. The runner uses its own pool (`createPrismaClient`, `max: 2`). Tests never call Open-Meteo (injected `fetch`, recorded fixtures in `src/weather/__fixtures__`). **Licence:** the free API is non-commercial only (~10k calls/day); production use needs a paid key, `OPEN_METEO_API_KEY` (switches to the `customer-*` hosts, incl. `customer-historical-forecast-api`; never logged). Every e2e `TRUNCATE` of `farms` must list `farm_weather` too. MCP: `get_weather`.
- **Farm rollups (History tab):** `farm_telemetry_rollups` (PK `(farm_id, bucket_start)`, FK farms CASCADE): 30-minute UTC buckets of each farm's series (per measurement timestamp: power **summed** over the turbines that reported, wind/rotor/pitch/gearbox **averaged**), with `readings`, `turbines` (distinct reporters) and `<power|wind_speed|rotor_rpm|blade_pitch|gearbox_temp>_open|close|high|low`, `computed_at`. Derived data, written only by the farm rollup job (`runFarmRollup`, `@nextera/shared` `src/wind/farm-rollup.ts`), never on ingest. Each run is one transaction with an advisory lock (a concurrent run is skipped) and recomputes, per farm, from the earliest bucket touched by telemetry rows created since the watermark (`farm_rollup_state`, on `telemetry.created_at`, index `telemetry_created_at_idx`, 10-minute lookback), from any `farm_rollup_dirty` markers, and over the current UTC day; it prunes buckets older than 190 days before the newest reading. A failed run changes nothing, the watermark included. A move rewrites `telemetry.farm_id` without new rows, so the trigger `turbines_farm_rollup_dirty` (AFTER UPDATE OF farm_id, in the migration; Prisma doesn't model it) writes markers for both farms from the turbine's first reading in the move's transaction. Daily candles are aggregated on read in any time zone (`farmDailyHistory`; open = first bucket's open, close = last bucket's close, high/low = max/min, `turbines` = max). `GET /api/farms/:farmId/telemetry/daily` sends a weak ETag over the body (304 on `If-None-Match`) and `Cache-Control: private, no-cache` (the browser revalidates every request, so a new rollup run shows at once; the web keeps its own 15-minute cache, which Refresh/Retry bypass); ≤ 183 days (+1 h DST slack). `db:seed`, `db:seed:demo` and `demo:reset` run one rollup after seeding; after CSV uploads in browser tests run `npm run rollup` (or wait for the compose `farm-rollup` service). Any e2e `TRUNCATE … farms` must include `farm_telemetry_rollups`.
- **Ingestion:** payload fields and CSV uploads both use the `telemetry.csv` format. Each new reading's triggered enabled rules are stored in `telemetry_alerts` in the same transaction. CSV uploads are all-or-nothing for format errors: every error is reported by line and nothing is stored if any row is invalid. Duplicates are skipped and counted. Idempotent on `(turbine_id, timestamp)`. Anomalous readings are stored. Invalid payloads return 400 (→ DLQ after retries). **Unallocated turbines:** readings for an unknown turbine or with a farm mismatch are **held** (2xx), not rejected: `classifyReadings` / `holdReadings` (`@nextera/shared`, `src/wind/unallocated.ts`) upsert an `unallocated_turbines` entry per (turbine_id, reported farm) and store the reading in `held_telemetry` (kept 7 days, `HELD_RETENTION_MS`). Readings for a **blocked** pair are dropped (2xx). At most `MAX_PENDING_UNALLOCATED` (500) pending entries: a new pair beyond that gets 400 (→ DLQ). CSV results add `held` and `blocked` counts. Writers take a per-turbine advisory lock, then `FOR UPDATE` on the entry, so a reading never races an assign. Owners resolve entries in the web app (assign / keep / move / block); `importHeld` moves held readings into `telemetry` with alerts evaluated. A move updates `turbines.farm_id`, and `telemetry.farm_id` follows through the FK's `ON UPDATE CASCADE` (the turbine's whole history moves). Events after commit: `unallocated-turbine.changed` (`UNALLOCATED_CHANGED`, `{action, id, turbineId}`), plus `fleet.changed` (`FLEET_CHANGED`, `{turbineId}`) and `telemetry.received` (newest imported reading) after assign/keep/move. SSE goes to every signed-in user, so these payloads carry only ids and actions.
- **API:** DTO validation and Prisma error mapping. CORS is limited to `CORS_ORIGINS` (`http://localhost:4200` locally, plus the compose `web` origin for the compose `api`; in GCP Terraform sets `https://nextera-web-<project number>.<region>.run.app` + `web_domain`. The hashed run.app URL is not allowed: use the `web_url` output). Every route needs a signed-in user unless it is `@Public()` (see **Auth**); each `/api/alert-configs` write publishes `alert-config.changed` (`ALERT_CONFIG_CHANGED` in `@nextera/shared`) after the commit.
- **Auth (MVP, owned by `auth-engineer`):** `POST /api/auth/login` (`{ email, password }` → `{ accessToken, expiresAt, user: { email, role } }`; every failure is 401 "Invalid email or password") issues one **HS256 JWT valid for 24 h** (`jose`; claims `sub` = user id, `role`, `iss` `JWT_ISSUER`, `aud` `JWT_AUDIENCE`, `iat`, `exp`, `jti`; algorithm pinned on verify, 30 s clock tolerance). No refresh tokens or revocation list: the `AuthGuard` reloads the user on every request, so deactivating a user or changing a role applies at once. Passwords are argon2id (m = 19 MiB, t = 2, p = 1, `PASSWORD_HASH_OPTIONS` in `@nextera/shared`); unknown emails verify a dummy hash. Global guards in `AppModule` (default deny): `AuthGuard` (Bearer header; `?access_token=` only on `GET /api/events`, marked `@AllowQueryToken()`, since `EventSource` can't send headers) answers a missing, invalid or expired token or an inactive user with **401** + `WWW-Authenticate: Bearer`; `RolesGuard` reads `@Roles(minRole)` (handler, then controller; routes without it are admin-only) and answers a too-low role with **404**, the exact body of an unknown route (`Cannot GET /api/...`). Roles are hierarchical, `viewer < owner < admin` (`Role`, `ROLE_RANK`, `hasRole` in `@nextera/shared`; mirrored by hand in `apps/web/src/app/core/auth/roles.ts`). Access matrix (prefix `/api`): public `GET /health/live`, `/health/ready`, `POST /auth/login`; viewer `GET /auth/me`, `/farms`, `/turbines/:id/telemetry` (+ `/stats`), `/events`, `/alerts`, `/alert-configs` (+ `/:id`); owner `POST`/`PATCH`/`DELETE /alert-configs`, `PATCH /turbines/:id`, `GET /reports/telemetry`, `/unallocated-turbines/**`; admin everything. The SSE stream ends when its token expires. The ingestion worker stays IAM-only (no user auth). CORS allows the `Authorization` header (no cookies, so no `credentials`). The web app keeps the session in **localStorage** for at most 24 h (`AuthStore`), adds the Bearer token to `API_BASE_URL` requests only (`authInterceptor`, a 401 → sign out → `/login`), guards `FleetShell` with `canMatch` (`/login` is outside it, so no fleet load or SSE before sign-in) and `/reporting` with `roleGuard('owner')`, and hides Reporting in the nav and Add/Edit/Delete on the Rules page for viewers. **Accepted PoC trade-offs:** a token in localStorage is readable by XSS; the SSE token in the query string appears in Cloud Run request logs; tokens can't be revoked before their 24 h end except by deactivating the user or rotating `JWT_SECRET` (which ends every session); no login rate limiting yet. Env: `JWT_SECRET` (≥ 32 characters, no default, `openssl rand -base64 48`; Secret Manager `jwt-secret` in GCP), `JWT_ISSUER` (default `nextera-api`), `JWT_AUDIENCE` (default `nextera-web`); `SEED_USER_PASSWORD` for the seed. Test users from `npm run db:seed`: `viewer@nextera.local`, `owner@nextera.local`, `admin@nextera.local`, all with `SEED_USER_PASSWORD`.
- **MCP server (`apps/mcp`):** local stdio only (started by the MCP client from `.mcp.json` / Claude Desktop), never deployed. **Read-only, and it stays that way:** tools only read through the shared queries, and every pooled connection sets `-c default_transaction_read_only=on`, so any write fails in Postgres with SQLSTATE 25006; never add a tool that writes, and never drop that setting. In GCP, point `MCP_DATABASE_URL` at a role that has only `SELECT`. stdout carries only JSON-RPC: log to stderr. It reads `MCP_DATABASE_URL`, else `DATABASE_URL` (repo-root `.env`), pool `max: 2`. Tool arguments mirror the API's limits (`limit` ≤ 2016, ranges ≤ 31 days, timestamps via `timestampProblem`), and errors (unknown turbine, bad range, database failure) are `isError` results, never a crash. `get_farm_daily` reads `farmDailyHistory` (daily candles of a farm, ≤ 183 days, `timeZone`). `get_weather` reads `farmWeather` / `turbineWeather` (exactly one of `farmId` and `turbineId`, a Zod refinement through `defineTool`'s `refine`; a turbine gets its farm's weather; `daily` by default, local days in `timeZone` (default UTC), or `30min`; ≤ 31 days). `list_unallocated` (pending|blocked, optional `turbineId`) and `get_unallocated_readings` (entry UUID, `limit` ≤ 2016) read `listUnallocated`/`getUnallocated`/`heldReadings` but never show `blockedBy` (the API shows that email to owners only; MCP has no users). `get_turbine` lists a turbine's pending unallocated entries and points an unknown but reporting id to `list_unallocated`.
- **Angular:** zoneless, signals, standalone components; OnPush is the default since Angular 22, so don't set `changeDetection`. Styling is **Tailwind CSS v4** utilities on top of the theme tokens in `src/styles.css` (`bg-page`, `text-muted`, `border-line` …). There is no component CSS. Tests use `data-testid`, never utility classes. The API base URL comes from `src/environments` in development; production builds have none and load it at runtime from `/config.json` (written by the container from `API_BASE_URL`). Restart `ng serve` after editing `angular.json` or `.postcssrc.json` (both are read at startup). Material: tables (`TABLE_IMPORTS`, `[appPaging]` paginators, `TableFrame` on window-high pages), `MatDialog` (the Rules page's editor/delete dialogs), `matButton`/`matIconButton`/`mat-button-toggle-group`, section tabs (farm, Alerting, Unallocated) through `PageTabs` (`ui/page-tabs.ts`: `mat-tab-nav-bar` + `mat-tab-link` with `routerLinkActive`, the page in a `mat-tab-nav-panel`; ARIA tablist/tab/`aria-selected`/tabpanel, no `aria-current`), all themed by mapping `--mat-*` tokens to ours in `styles.css` (no Material theme). `@defer` keeps ECharts and Leaflet out of every route chunk: the maps (`on viewport; prefetch on idle`), the turbine page's chart group (`on idle; prefetch on immediate`, deferred as a unit), Reporting's charts (`when` a report has readings, `prefetch on idle`) and History's alert chips (`when` a row is expanded; the chunk now holds only `AlertChips`, since the chip module is shared). Farm IDs are `FarmPill` (`ui/farm-pill.ts`): a bare read-only `mat-chip` without a `mat-chip-set`, themed by `.farm-pill` in `styles.css`; it puts `@angular/material/chips` (about 36 KB raw, 6 KB transfer) in a shared lazy chunk on the Farms, Turbines and Unallocated routes. Defer local components only (a deferred package export pulls in its whole module; keep type imports in their own `import type` line), behind same-size placeholders (`ChartSkeleton`, `MapPlaceholder`), with `@loading (after 100ms; minimum 300ms)` and a reload `@error`. Tests: `test-setup.ts` stubs `IntersectionObserver`; `openFleet` preloads the deferred chunks and its `stable()` waits for defer triggers; placeholder states use `openFleet(…, { deferBlockBehavior: DeferBlockBehavior.Manual })` (see the angular-engineer agent). Stable Angular APIs only. Loads use `rxResource` through `latestLoad` (`ui/latest-load.ts`: History, Reporting, `AlertRulesStore`). Forms are Signal Forms (`@angular/forms/signals`: `form()` over a model signal, schema validators, `[formField]` on Material controls, `[formRoot]` on the `<form>`; Material 22.2 reads the field state for its error state); no Reactive Forms. Native selects bound with `[formField]` update on `input`, so specs dispatch `input` (and `change`) like a browser. Testing a resource: it sends its request on the next change detection and is a PendingTasks entry while loading, so `fixture.whenStable()` and Material harness actions hang until its request is flushed: call `TestBed.tick()` before `expectOne`, flush, then wait a task (`setTimeout`) or `whenStable()`. Dates and time zones: date-fns 4 with `@date-fns/utc` and `@date-fns/tz`; times show in **UTC by default, or the browser's zone** (Settings). `TimeZoneSettings` (`core/time-zone.ts`: `mode`/`zone`/`ctx`/`label`/`tag`, saved per user email in localStorage, browser zone from the `BROWSER_TIME_ZONE` token) gives the date-fns `in` context; templates use the `appTime` pipe (`t | appTime: 'MMM d, HH:mm'`, `: true` adds the zone name), never `| date: … : 'UTC'`. Helpers in `core/days.ts` (zone-aware whole days; a DST day is 23/25 h) and `charts/scales.ts` (ticks and candles aligned in the zone). Staleness, the turbine page's relative windows, the API/SSE and CSV row timestamps stay UTC/relative. `FleetShell` owns `FleetStore` (the Rules page provides its own `AlertRulesStore`), the live SSE connection and a side nav (left column on desktop, top bar with a menu toggle on phones):
  - **Farms** (`/farms`; `/` and unknown URLs redirect there), farm first: `/farms` (fleet overview: Leaflet map of all farms + farm table; farm IDs show as a `FarmPill` in the farm table, which opens the farm like the rest of the row, and in the farm header on all tabs) → `/farms/:farmId` (tabs Overview | History | Weather history under the farm header, a routed Material tab nav bar like Alerting's (PageTabs), every role: **History** at `/farms/:farmId/history` (`farm-history/`) — one daily candlestick chart of the farm's power output (sum over its turbines) from `GET /api/farms/:farmId/telemetry/daily` (the rollup job's figures; the other metrics in the response aren't shown), one candle per day in the zone shown (23/25 h on DST days; tooltip: date, start/end/low/high, "N of M turbines reporting"), ranges 30d / 90d / 6 months (182 days) ending today, "Updated <computedAt>" + "Daily figures refresh every 15 minutes.", answers kept in memory per (farm, range, zone) for 15 minutes (`FarmHistoryCache`, provided by `FleetShell`; Retry and Refresh skip it); **Overview** at `/farms/:farmId` — farm tiles, a Weather section (`weather/farm-weather.ts`): Open-Meteo tiles for the newest 30-minute bucket (80 m wind, gusts, temperature, precipitation) and today's temperature min/max, plus a 7-day daily table (mean/max 80 m wind, temperature min/max, precipitation, coverage = `samples` of 48, 46/50 on DST days), from `GET /api/farms/:farmId/weather` twice (`interval=30min` for the last 24 h; `interval=daily` with `timeZone` = the zone shown, reloaded when the time-zone setting changes), map of that farm's turbines + the same turbines table as `/turbines`, scoped to the farm, without the Farm column — and **Weather history** at `/farms/:farmId/weather` (`weather/farm-weather-history-page.ts`) — a required Material date range of whole days in the zone shown (default the last 7 ending today, ≤ 31, same `rangeError` rules), one `GET /api/farms/:farmId/weather?interval=30min` per range, eight line charts (80 m wind, 10 m wind, gusts, temperature, precipitation per 30 min, humidity, surface pressure, cloud cover) behind `@defer` with the shared crosshair, zoom and Reset zoom, missing buckets as gaps; loading, empty, error with Retry; a zone change re-queries the same calendar dates; the turbine page has no tabs) → `/farms/:farmId/turbines/:turbineId` (one ECharts candlestick chart per metric — candles in the zone shown, sized to the range (6h → 15 min, 24h → 30 min, 48h → 1 h, 7d → 4 h), hollow rising / solid falling, drag to brush a range that zooms every chart, "Reset zoom" button — plus an "Alert rules triggered" chart — rules per reading as the line, flagged readings as a level-coloured scatter overlay with a legend and the rules in the tooltip — all with a shared crosshair, a shared dataZoom time window — slider + drag/Ctrl+wheel, dashed median/high/low reference lines for the selected range, a time-range row whose window ends at the client clock, readings table whose Alerts column shows one "Level: count" pill per level triggered, worst first, as on History, with every rule in a tooltip; an empty window shows a message instead of charts. No weather here: the farm's Open-Meteo weather is shown only on the farm page).
  - **Turbines** (`/turbines`): every turbine with its farm (name + the ID as a read-only `FarmPill`), status, Commissioned (viewers: check mark or X; owners and admins: a `mat-slide-toggle` named "Mark <turbine> as commissioned" over `FleetStore.setCommissioned`, optimistic with rollback, which stays focusable while saving; if the change moves the row focus follows to its switch, and if the row leaves the page focus goes to the match count), latest values; sortable (default: last reading, newest first; turbines with no readings last in either direction; ties by id) and filterable (text, status, commissioning, and a "Hide turbines with no data" `mat-slide-toggle`, `hide-no-data`, on by default and not saved: it hides only turbines that have never reported, not "No data in 15/30/60 min" ones). Choosing the status "No readings yet" overrides the switch (shown off and disabled; the user's setting returns with another status). The count adds "· M with no data hidden", and an empty table says when only the switch is hiding turbines. The table is the shared `TurbineTable` (`fleet/turbine-table.ts`), also used by the farm page. No Alert column: alerts are evaluated at ingestion and shown on the turbine page's alerts chart and the Alerting History tab. Live updates are calm (shared table, so also the farm Overview): cells, filters and the count follow every reading, and every updated row flashes for 2 s (`FleetStore.recentlyUpdated`, a set of ids with one timer each), but the row order is held during a burst and applied 1 s after the last reading, or after 3 s at most. The rows then glide to their new places over 500 ms (`ui/row-glide.ts`: a FLIP on row `transform` with the Web Animations API, off with `prefers-reduced-motion`, keeps focus and the running flash). Sort, filter and farm changes apply at once without a glide; a turbine that newly matches a filter shows at once in its last known place and moves when the order applies.
  - **Tables** are Angular Material `mat-table` with a `mat-paginator`, paged client-side from signals (`ui/paging.ts`); the farms table is not paginated.
  - **Alerting**: `/alerting` (redirects to History; tabs History and Rules), `/alerting/history` (History: `GET /api/alerts` for whole days (UTC, or local days in local mode) chosen with a Material date range picker (native DateAdapter), default yesterday–today; Material table with expandable rows — one summary row per turbine (farm, latest alert, an Alerts column with one "Level: count" pill per level: every rule each reading triggered, worst level first) that expands to its readings, each with its rules as level-coloured Material chips; 25 turbines per page) and `/alerting/rules` (Rules: CRUD for `alerts_config`, plus an Enabled `mat-slide-toggle` per rule for owners and admins: optimistic `PATCH {enabled}` with rollback; viewers see Enabled/Disabled; disabled rules are muted with a "Disabled" pill; the editor has an Enabled switch, on for new rules. Deleting a rule that readings triggered (409) explains why in words and offers "Disable rule", or only Close if it's already disabled). History, Weather history and Reporting query only a complete date range: nothing is sent and no error is shown while the calendar is open.
  - **Unallocated** (`/unallocated` → `/unallocated/pending`, tabs Pending and Blocked; owner and admin only, `roleGuard('owner')`): turbines whose readings are held. Pending: expandable rows (turbine with its problem, reported/current farm as the name + a `FarmPill` with the ID: "Unknown farm" + the ID when the reported farm doesn't exist, "Not in the fleet" when it has no current farm, last/first seen with staleness, held count; expanded = the newest 24 held readings, the first being the latest values), the actions column pinned right (`stickyEnd`) when the table scrolls on narrow windows, one primary action per row by kind — Assign to farm… (unknown turbine: dialog, farm autocomplete, optional coordinates) or Keep in <current farm> (farm mismatch, direct) — and a "More actions for <turbine>" `mat-menu` (`more-actions`) with Move <turbine> to <reported farm>… (mismatch only; confirm dialog; a disabled item with the reason when that farm doesn't exist) and Block <turbine> from <reported farm>… (confirm dialog). Menu items that open a dialog focus the menu trigger first, so focus returns there. Blocked: reported farm (same name + `FarmPill`), blocked at/by, Unblock. `UnallocatedStore` (per page, `latestLoad`) reloads on `FleetStore.unallocatedVersion`; `fleet.changed` calls `FleetStore.reloadFleet(turbineId)`, which also lets that turbine's next live reading past the unlisted-turbine guard while the farms reload. HTTP error text is shared in `core/http-errors.ts`.
  - **Reporting** (`/reporting`, proof of concept; owner and admin only): a farm or turbine from a Material autocomplete (Farms / Turbines groups) and a required Material date range (whole days in the zone shown, ≤ 31; 30 when they cross an autumn DST change, the API's 31 × 24 h limit) → one `GET /api/reports/telemetry` → summary tiles, one `LineChart` per metric (a farm: power summed, the rest averaged per time) + an alerts chart, a paginated readings table, and a CSV download built in the browser (telemetry.csv columns + `alerts`).
  - **Settings** (`/settings`, every role, last nav item): time zone UTC (default) or Local ("Local (America/Chicago, UTC−6)"), a live preview, saved in this browser per user; every page follows at once (including the Unallocated first/last seen times).
  - **Staleness** uses the client clock (`NOW` token, `FleetStore` ticks every minute): more than 15/30/60 min since the latest measurement → "No data in 15/30/60 min" (yellow/orange/red pills, `fleet/staleness.ts`); only `ok` turbines count as reporting.
- **Containers:** one image per service: `apps/api/Dockerfile` and `apps/ingestion/Dockerfile` (build context = repo root, because both need `packages/shared` and the root lockfile; each installs only its own workspace + `@nextera/shared` via `npm ci -w <app> -w @nextera/shared --include-workspace-root`), and `apps/web/Dockerfile` (build context = `apps/web`; Node build stage, unprivileged nginx runtime). Images are non-root, `linux/amd64` for Cloud Run, listen on `$PORT`, and contain no dev packages or secrets. The web image has no API URL baked in: it refuses to start unless `API_BASE_URL` is `https://…/api` (http only for localhost). Its nginx sends a CSP and HSTS (`max-age=31536000`, no `includeSubDomains`) on every response; the CSP's `connect-src` is `'self'` + the API origin that `docker/40-runtime-config.sh` derives from `API_BASE_URL` at startup (an nginx `map` include), `script-src 'self'` only (the production build turns off `inlineCritical`, whose inline script it would block; `autoCsp` is still experimental), `style-src 'self' 'unsafe-inline'` for the `<style>` elements Angular/Material inject. Tags: `$REGISTRY/api:$TAG`, `$REGISTRY/ingestion:$TAG`, `$REGISTRY/web:$TAG`. Compose runs `api` and `ingestion` with Cloud Run's limits (`mem_limit: 512m`, `cpus: 1`; keep them in step with `run.tf`).
- **Infrastructure:** change GCP only through `infra/terraform`. Run `terraform fmt -check` + `validate` before committing.
- **CI/CD:** `.github/workflows/ci.yml` runs every check on PRs and `main`, including the `browser-e2e` job (compose stack + `db:seed` + Playwright, throwaway `.env`), so a failing browser test blocks deploys; `deploy.yml` runs after a green CI on `main` (or manually on `main`). It authenticates with Workload Identity Federation (no service account keys), uses only repository **variables** (nothing secret), and pins action major versions. Deploys never run concurrently.
- **Never commit:** secrets, `.env`, `*.tfvars` or Terraform state.
- **Tests:** every change includes tests.
  - **Backend unit tests** (`*.spec.ts`, Vitest) mock Prisma with `vitest-mock-extended`.
  - **Backend e2e tests** (`test/*.e2e-spec.ts`) run against Testcontainers Postgres 18 + Redis 8 (Docker required). Migration tests live in `packages/shared/test` (existing data survives the migration, no drift).
  - **Angular tests** use Vitest + TestBed with a `FakeEventSource`. ECharts (SVG renderer) runs in jsdom without a canvas mock (`src/testing/test-setup.ts` stubs `ResizeObserver`). jsdom has no layout, so verify chart rendering in a browser. Coverage: `npm run test:coverage` (v8; `src/app/**`, without specs and test helpers; report in `coverage/web/`); its thresholds (`coverageThresholds` in `angular.json`) are a ratchet at the current numbers: raise them when coverage goes up, never lower them. CI's `web` job runs it and uploads `apps/web/coverage/`.
  - **Browser E2E** (`e2e/`, Playwright, Chromium) tests the built compose `web` image (`E2E_WEB_URL`, default :8082), so rebuild it after app changes (`docker compose up -d --wait --build api ingestion web`). It needs the `db:seed` fixture and fixes the browser clock at the seed test's `SEED_NOW` (2026-01-03T00:00Z); `SEED_USER_PASSWORD` comes from `.env`. Prefer role, label and `data-testid` locators. Projects: `read-only` (fully parallel; everything outside `tests/data/`) and then `data` (`tests/data/**`, one worker): [DATA] tests (rule CRUD, CSV uploads to ingestion :8081) go there and clean up after themselves. `--project read-only` or `--no-deps` skips the dependency.

## Common commands

```bash
# First time
cp .env.example .env                          # then set JWT_SECRET (openssl rand -base64 48) and SEED_USER_PASSWORD
npm install                                   # all workspaces; also builds @nextera/shared
(cd apps/web && npm install)

# Local stack
docker compose up -d --wait postgres redis pubsub pubsub-init   # dependencies only; run services on the host
docker compose up -d --wait --build api ingestion               # or everything in containers (migrate runs first)
docker compose up -d --wait --build web                         # the production web image on :8082 (→ compose api on :8080)
docker compose down                                             # add -v to wipe the database volume

# Images -> any registry (REGISTRY/TAG from the environment; default nextera/<svc>:latest)
export REGISTRY=us-central1-docker.pkg.dev/<project>/nextera TAG=$(git rev-parse --short HEAD)
gcloud auth configure-docker us-central1-docker.pkg.dev        # once, for Artifact Registry
npm run docker:build                                            # buildx linux/amd64: docker:build:api / :ingestion / :web
npm run docker:push                                             # docker push all three
# or with compose (REGISTRY/TAG from .env; DOCKER_DEFAULT_PLATFORM=linux/amd64 on Apple Silicon for Cloud Run):
docker compose build api ingestion web && docker compose push api ingestion web

# Backend (repo root)
npm run dev:shared                            # rebuild @nextera/shared on change (watch)
npm run dev:api                               # http://localhost:3000/api, SSE at /api/events
npm run dev:ingestion                         # http://localhost:3001/pubsub/telemetry
npm run dev:web                               # Angular on :4200 (= npm start in apps/web; dev:web:docker → compose API)
npm run ingest:publish -- --count 3           # publish synthetic readings to the emulator
npm run ingest:publish -- --turbine TURB002 --gearbox-temp 126.5   # an anomaly
npm run ingest:publish -- --delay-minutes 20  # a late-arriving reading
curl -F file=@readings.csv localhost:3001/ingest/telemetry   # bulk upload (telemetry.csv format; compose: :8081)
npm run db:migrate -- --name <change>         # create + apply a migration
npm run db:seed                               # load prisma/data/*.csv + the viewer@/owner@/admin@nextera.local users (idempotent; needs SEED_USER_PASSWORD)
npm run rollup                                # one farm rollup run (incremental; -- --full = last 190 days, -- --from YYYY-MM-DD); rollup:watch loops
npm run db:seed:demo                          # demo data instead: 200 turbines, default rules, 72 h up to now + anomalies (re-run tops up; SEED_HOURS/SEED_NOW)
npm run demo:reset -- --yes                   # local demo from scratch: clear readings, 7 days of demo data up to now, weather, live feed (local DB only unless --allow-remote)
npm run load:setup && npm run load:ingest && npm run load:reads && npm run load:check   # Artillery smoke run against the throwaway load/docker-compose.yml stack; install, env and teardown in docs/load-test.md (not in CI)
npm run weather:sync -- --from 2026-01-01 --to 2026-01-31   # Open-Meteo weather per farm (default: last 7 UTC days; --farm FARM01)
DEMO_FEED_ENABLED=true npm run demo:feed      # live demo readings every DEMO_FEED_INTERVAL_SECONDS to the emulator (-- --once: one tick); db:seed:demo first
# compose demo-feed: set DEMO_FEED_ENABLED=true (or false) in .env, then `docker compose up -d demo-feed`. Disabled it
# logs "Demo feed disabled" and idles instead of exiting, so a bare `docker compose up -d --wait` still succeeds.
npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build

# Browser E2E (e2e/, Playwright) against the compose stack
(cd e2e && npm ci && npx playwright install chromium)                     # once
docker compose up -d --wait --build api ingestion web && npm run db:seed  # stack (rebuilt) + fixture
cd e2e && npx playwright test                 # read-only project, then the serial data project (--list, --ui)

# MCP server (apps/mcp): read-only fleet tools for Claude Code (.mcp.json "nextera") / Claude Desktop
npm run build -w @nextera/mcp                 # then restart Claude Code and approve the "nextera" server
npm run dev -w @nextera/mcp                   # run from source over stdio (tsx); logs on stderr
npx @modelcontextprotocol/inspector node apps/mcp/dist/main.js   # try each tool by hand

# Angular (apps/web)
npm start                                     # http://localhost:4200, talks to the API on :3000 (npm run dev:api)
npm run start:docker                          # same, but talks to the compose api container on :8080
npm test                                      # Angular tests + the container's API_BASE_URL script tests (test:docker)
npm run test:coverage                         # Angular tests with coverage (fails below the thresholds); report in coverage/
npm run build                                 # production build (the API URL is runtime config, not built in)

# Terraform (no local install needed)
alias tf='docker run --rm -it -v "$PWD":/w -w /w -v ~/.config/gcloud:/root/.config/gcloud hashicorp/terraform:latest'
cd infra/terraform && tf fmt -check && tf init -backend=false && tf validate && tf test   # tests: mock providers, offline
cd infra/terraform && tf init -backend-config="bucket=<state-bucket>" -backend-config="prefix=nextera/prod"
cd infra/terraform && tf plan && tf apply     # needs terraform.tfvars (copy terraform.tfvars.example)
```

## Deploying

Pushes to `main` deploy automatically: when **CI** succeeds on `main`, `.github/workflows/deploy.yml` (GitHub environment `production`) runs:

1. Authenticates as the `nextera-deployer` service account through Workload Identity Federation.
2. Builds and pushes `api`, `ingestion` and `web` (`linux/amd64`) to Artifact Registry, tagged with the commit SHA.
3. Starts the Cloud SQL Auth Proxy with `--unix-socket /cloudsql`, reads the `database-url` secret (the same `/cloudsql/<connection>` socket URL Cloud Run uses), and runs `npm run db:deploy` (`prisma migrate deploy`). **The workflow stops here if the migration fails**; the running services are untouched.
4. `gcloud run deploy nextera-api` and `nextera-ingestion` with the new images.
5. `gcloud run deploy nextera-web` with the new image, only after step 4 succeeded (the new frontend may need the new API).
6. `gcloud run jobs update` the demo feed job with the new ingestion image, only if the repository variable `DEMO_FEED_JOB` is set (see **Demo feed** below).
7. `gcloud run jobs update` the weather sync job with the new ingestion image, only if the repository variable `WEATHER_SYNC_JOB` is set (see **Weather sync** below).
8. `gcloud run jobs update` the farm rollup job (`nextera-farm-rollup`) with the new ingestion image, only if the repository variable `FARM_ROLLUP_JOB` is set (Terraform `farm_rollup_enabled`, on by default; see **Farm rollup** below).

**API URL of the web app:** runtime config, not build-time. Terraform sets `API_BASE_URL` (`api_url` output + `/api`) on `nextera-web`. At startup `apps/web/docker/40-runtime-config.sh` validates it (https, ends in `/api`, not an `example.*` placeholder) and writes `/config.json`, which `src/main.ts` fetches before bootstrapping. A bad value stops the container, so Cloud Run keeps serving the previous revision. Changing `api_domain` only needs `tf apply`, no rebuild.

The workflow-level `concurrency` group `deploy-production` makes sure two deploys (and two migrations) never overlap. Re-run a deploy with **Actions → Deploy → Run workflow** on `main`.

### One-time setup

```bash
# 1. Infrastructure: set github_repository = "owner/repo" in terraform.tfvars, and (recommended)
#    github_repository_id = "<gh api repos/OWNER/REPO --jq .id>" so WIF also checks the immutable id, then
cd infra/terraform && tf init -backend-config=... && tf plan && tf apply

# 2. GitHub: create the environment "production" (Settings → Environments). Restrict its
#    deployment branches to main (optionally add required reviewers). Only jobs in this environment
#    can impersonate the deployer service account.

# 3. Repository variables (not secrets) from the Terraform outputs; needs gh + jq.
#    (No -it here: the tf alias's -it breaks pipes.)
docker run --rm -v "$PWD":/w -w /w -v ~/.config/gcloud:/root/.config/gcloud hashicorp/terraform:latest \
  output -json github_actions_variables | jq -r 'to_entries[] | "\(.key)=\(.value)"' > /tmp/gh-vars.env
gh variable set -f /tmp/gh-vars.env   # GCP_PROJECT_ID, GCP_REGION, GCP_WIF_PROVIDER, GCP_DEPLOYER_SA,
                                      # GCP_REGISTRY, CLOUDSQL_INSTANCE (+ DEMO_FEED_JOB if demo_feed_enabled)
```

#### Monitoring

`monitoring.tf` always creates HTTPS uptime checks (api `/api/health/ready`, web `/`) and alert policies (dead letters, ingestion backlog, Cloud Run 5xx ratio per service, uptime failures, Cloud SQL CPU and connections, Redis memory; each says what to do). Thresholds are locals at the top of the file. `alert_emails` adds one email notification channel per address to every policy (no verification needed; send a test notification from the console). Without it the policies only open incidents in the console. An optional monthly budget on this project needs `billing_account` + `monthly_budget`, and whoever applies needs `roles/billing.costsManager` on the billing account (its API calls are billed to the project through the `google.billing_budget` provider alias). Tests: `tf test` (mock providers, offline).

#### Auth secrets

Terraform creates the `jwt-secret` secret (mounted as `JWT_SECRET` on `nextera-api` only, next to `JWT_ISSUER=nextera-api` / `JWT_AUDIENCE=nextera-web`) but never its value, so the key stays out of state. The API refuses to start without it, and Cloud Run can't create an API revision until the secret has a version. So on the first apply (or the first apply after upgrading), create the secret, add the key, then apply the rest:

```bash
cd infra/terraform && tf apply -target=google_secret_manager_secret.jwt
printf %s "$(openssl rand -base64 48)" | gcloud secrets versions add jwt-secret --data-file=-
tf apply                                      # now the API revision can read JWT_SECRET
```

A new version rotates the key: every session ends once the API runs on it. Seed the test users (`viewer@`, `owner@`, `admin@nextera.local`) into Cloud SQL like the break-glass migration below (`roles/cloudsql.client` + the `database-url` secret), after `db:deploy` created the `users` table. `db:seed` is idempotent (it also loads the CSV fleet data) and refuses to run without `SEED_USER_PASSWORD`:

```bash
sudo mkdir -p /cloudsql && sudo chown "$USER" /cloudsql
cloud-sql-proxy --unix-socket /cloudsql $CONN &
DATABASE_URL="$(gcloud secrets versions access latest --secret database-url)" \
  SEED_USER_PASSWORD='<a strong password, shared out of band>' npm run db:seed
```

Until the first deploy, the Cloud Run services (including `nextera-web`) serve Terraform's placeholder image.

Then push to `main` (or run **Deploy** manually).

### Demo feed (optional)

`demo_feed_enabled = true` (default false) creates the Cloud Run Job `nextera-demo-feed` (ingestion image, `node dist/demo-feed/main.js --once`, its own SA with `roles/pubsub.publisher` on `telemetry` only) and a Cloud Scheduler job that runs it every 5 min through the Cloud Run Admin API (OAuth, a scheduler SA with `roles/run.invoker` on that job only), and enables `cloudscheduler.googleapis.com`. `demo_feed_paused = true` keeps both but pauses the schedule. The job image is a placeholder until `ingestion_image` or a deploy sets it (Terraform ignores image changes afterwards), and executions fail on the placeholder. Seed first, as above but with `npm run db:seed:demo` (unknown turbines → 400 → DLQ):

```bash
DATABASE_URL="$(gcloud secrets versions access latest --secret database-url)" SEED_USER_PASSWORD='…' npm run db:seed:demo
# on: demo_feed_enabled = true in terraform.tfvars, then (the -var gives the new job a real image at once)
tf apply -var ingestion_image=$REG/ingestion:$SHA && gh variable set DEMO_FEED_JOB --body nextera-demo-feed
gcloud run jobs execute nextera-demo-feed --region $REGION   # a tick now (else the next 5-min schedule)
# pause / resume: demo_feed_paused = true / false, then tf apply
# off: delete the variable first (else the next deploy fails on the missing job), then demo_feed_enabled = false
gh variable delete DEMO_FEED_JOB && tf apply
```

### Farm rollup

`farm_rollup_enabled` (default **true**: the farm History tab reads its table) creates the Cloud Run Job `nextera-farm-rollup` (ingestion image, `node dist/farm-rollup/main.js`, Cloud SQL socket + `database-url`, its own SA with `cloudsql.client` and that secret only; 300 s timeout, 1 retry) and a Cloud Scheduler job that runs it every 15 min (`farm_rollup_schedule`, UTC; a scheduler SA with `run.invoker` on that job only). A failed run is caught up by the next one; a failed execution of any scheduled job opens the `nextera: Cloud Run Job execution failed` incident (monitoring.tf). **First apply** (it is on by default, so every environment gets it): run `db:deploy` first (the job needs its tables), apply with `-var ingestion_image=$REG/ingestion:$SHA` (else it runs the placeholder and fails every 15 min), then `gh variable set FARM_ROLLUP_JOB --body nextera-farm-rollup` so deploys update its image.

```bash
gcloud run jobs execute nextera-farm-rollup --region $REGION                                             # a run now
gcloud run jobs execute nextera-farm-rollup --region $REGION --args=dist/farm-rollup/main.js,--full     # rebuild 190 days
# pause / resume: farm_rollup_paused = true / false, then tf apply (the History tab stops updating while paused)
# off: gh variable delete FARM_ROLLUP_JOB first (else the next deploy fails), then farm_rollup_enabled = false && tf apply
```

### Weather sync (optional)

`weather_sync_enabled = true` (default false) creates the Cloud Run Job `nextera-weather-sync` (ingestion image, `node dist/weather-sync/main.js`: the last 7 UTC days, all farms; its own SA with `roles/cloudsql.client` and the `database-url` secret only; Cloud SQL socket like `nextera-ingestion`; public egress to Open-Meteo) and a Cloud Scheduler job (`weather_sync_schedule`, default `30 1 * * *` UTC; its own scheduler SA with `roles/run.invoker` on that job only). `weather_sync_paused = true` pauses the schedule. The job starts on the placeholder image, like the demo feed. Production use needs an Open-Meteo API key: `open_meteo_api_key_enabled = true` mounts `OPEN_METEO_API_KEY` from the `open-meteo-api-key` secret, whose value Terraform never sets, so add a version first:

```bash
# key (optional, before enabling it): create the secret, add the key, then apply the rest
tf apply -target=google_secret_manager_secret.open_meteo_api_key
printf %s '<key>' | gcloud secrets versions add open-meteo-api-key --data-file=-
# on: weather_sync_enabled = true in terraform.tfvars, then
tf apply -var ingestion_image=$REG/ingestion:$SHA && gh variable set WEATHER_SYNC_JOB --body nextera-weather-sync
gcloud run jobs execute nextera-weather-sync --region $REGION        # a run now (else the next schedule)
# backfill: --args replaces the job's args, so repeat the script path
gcloud run jobs execute nextera-weather-sync --region $REGION --args=dist/weather-sync/main.js,--from,2026-01-01,--to,2026-01-31
# off: delete the variable first (else the next deploy fails on the missing job), then weather_sync_enabled = false
gh variable delete WEATHER_SYNC_JOB && tf apply
```

A failed run has no alert policy yet (a small `monitoring.tf` follow-up).

### Manual deploy (break-glass)

With `roles/cloudsql.client` and access to the `database-url` secret (`REG` = `registry` output, `SHA` = git commit, `CONN` = `sql_connection_name` output):

```bash
REGISTRY=$REG TAG=$SHA npm run docker:build && REGISTRY=$REG TAG=$SHA npm run docker:push

sudo mkdir -p /cloudsql && sudo chown "$USER" /cloudsql
cloud-sql-proxy --unix-socket /cloudsql $CONN &
DATABASE_URL="$(gcloud secrets versions access latest --secret database-url)" npm run db:deploy   # stop here if it fails
gcloud run deploy nextera-api       --image $REG/api:$SHA       --region $REGION
gcloud run deploy nextera-ingestion --image $REG/ingestion:$SHA --region $REGION
gcloud run deploy nextera-web       --image $REG/web:$SHA       --region $REGION   # only after the API is up
gcloud run jobs update nextera-demo-feed --image $REG/ingestion:$SHA --region $REGION  # only if demo_feed_enabled
gcloud run jobs update nextera-weather-sync --image $REG/ingestion:$SHA --region $REGION  # only if weather_sync_enabled
gcloud run jobs update nextera-farm-rollup --image $REG/ingestion:$SHA --region $REGION   # only if farm_rollup_enabled (default)
```

To redeploy only the web app: `REGISTRY=$REG TAG=$SHA npm run docker:build:web && docker push $REG/web:$SHA`, then the `nextera-web` line above. Its `API_BASE_URL` stays as Terraform set it.

Create the DNS records from the `api_dns_records` and `web_dns_records` outputs. The managed certificates provision once DNS resolves.
