# CLAUDE.md

This file guides Claude Code when working in this repository.

## Project overview

Take-home exercise: **wind-farm fleet monitoring**. Turbine telemetry (power, wind, rotor speed, blade pitch, gearbox temperature, every 5 minutes) is ingested from **Pub/Sub** by a **NestJS ingestion worker**, stored in **PostgreSQL** with **Prisma**, and streamed live over **Server-Sent Events** by a **NestJS API & SSE service** to an **Angular** app. The services and the app (nginx) run on **Google Cloud Run**, and the infrastructure is defined with **Terraform**. Local development mirrors it with **docker-compose**.

```
turbines → Pub/Sub "telemetry" ─push→ Ingestion Worker ─→ Postgres + Redis ─→ API & SSE ←─ Angular (Cloud Run, nginx)
                 └─ dead-letter topic after N failed deliveries                 (REST + SSE, CORS, own domain)
```

## Specialist agents

`.claude/agents/` holds the patterns to follow and the gotchas already hit. Use them for work in their area. Each spawn starts cold, so don't add agents to save money: keep prompts short, and send follow-ups to the same agent with `SendMessage`.

| Lane | Agent | Model | Owns |
|---|---|---|---|
| Backend | `nestjs-engineer` | Sonnet | `apps/api`, `apps/ingestion`, `apps/mcp`, `packages/shared`, the service images, backend tests |
| Web logic | `angular-engineer` | Sonnet | stores, services, routes and working templates in `apps/web`, the web image |
| Web UI | `angular-material-engineer` | Sonnet | all Material/CDK UI, `styles.css` tokens, UI accessibility, harness specs |
| Web tests | `web-test-engineer` | Sonnet | test-only work in `apps/web`, coverage ratchet, `e2e/` |
| Infra | `infra-engineer` | Sonnet | `infra/terraform` (incl. WIF, deployer SA), `docker-compose.yml`, registry |
| CI | `cicd-engineer` | Sonnet | `.github/workflows` |
| Auth | `auth-engineer` | Opus | auth across the API and web app; runs alone when it touches another lane's files |
| Design | `fullstack-architect` | Opus | read-only: returns a contract when a cross-service design is really open |

**Playwright agents** (Playwright's own generated agents; don't edit them): `playwright-test-planner` writes plans to `e2e/specs/*.md`, `playwright-test-generator` turns them into `e2e/tests/**`, `playwright-test-healer` fixes failing tests. They need the `playwright-test` MCP server (`.mcp.json`) and the running compose stack + `db:seed` fixture (see **Tests**).

**Routing web work:** UI-only changes go straight to `angular-material-engineer`. A feature with logic and UI goes to `angular-engineer` first (logic, state, data, a working template), then `angular-material-engineer`, in sequence on shared files.

**Order for a full-stack feature:**
1. **Contract:** the main session fixes routes, response shapes, env vars, signal names, job names and variables. Use `fullstack-architect` only if the design is really open.
2. **In parallel:** backend, web logic, infra and CI, with the contract pinned in every prompt and the other lanes' areas named as off limits.
3. **UI:** in parallel with step 2 only if the files don't overlap.
4. **Tests:** web tests after the UI. Backend tests stay with the backend lane.
5. **Verify:** the main session runs the full checks once.

**Parallel rules:**
- **One writer for hot files:** agents never edit `CLAUDE.md` or `.claude/rules/` (they return proposed lines; the main session applies them). Only Web UI edits `styles.css`, only Backend edits `schema.prisma`, only Web logic edits `app.routes.ts`, and only one agent per run changes dependencies.
- **Scoped checks:** agents run only their own specs and trim output, because another agent's half-finished edit can fail a repo-wide check. The main session runs the full suite and Testcontainers e2e.
- **Worktrees** (`isolation: "worktree"`) only when two agents must work in the same area: each adds an install and a merge.

**Skills:** installed with `npx skills` into `.agents/skills/` (pinned in `skills-lock.json`) and symlinked into `.claude/skills/`, where Claude Code discovers them. After `npx skills add`, symlink any new skill the same way. `zod` and `angular-material` are repo-local: written here, committed with the code and not in the lock. Agents preload only what nearly every task needs and name the rest to read on demand. The agent files take precedence over the general skill guidance (e.g. no component CSS, Cloud Run + Pub/Sub push).

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
.claude/                # agents/ (one per lane), rules/ (area rules, path-scoped), refs/ (agent reference, read on demand), skills/
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
- **Area rules live in `.claude/rules/`** and load when you read matching files. If you work in an area and its rules are not in your context, read the file:
  - `web.md`: Angular conventions, every page, web and browser tests.
  - `backend.md`: the data model, ingestion, API and MCP server.
  - `auth.md`: login, JWT, guards, roles, the access matrix.
  - `demo-data.md`: the demo seed, anomalies, feed and reset.
  - `weather-rollups.md`: farm weather and farm rollups (every e2e `TRUNCATE` of `farms` must also list `farm_weather` and `farm_telemetry_rollups`).
  - `deploy.md`: containers, CI/CD, image and Terraform commands, deploying, runbooks.
- **Infrastructure:** change GCP only through `infra/terraform`. Run `terraform fmt -check` + `validate` before committing.
- **Never commit:** secrets, `.env`, `*.tfvars` or Terraform state.
- **Tests:** every change includes tests.
  - **Backend unit tests** (`*.spec.ts`, Vitest) mock Prisma with `vitest-mock-extended`.
  - **Backend e2e tests** (`test/*.e2e-spec.ts`) run against Testcontainers Postgres 18 + Redis 8 (Docker required). Migration tests live in `packages/shared/test` (existing data survives the migration, no drift).
  - **Angular tests and Browser E2E:** see `.claude/rules/web.md`.

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


## Deploying

Pushes to `main` deploy automatically after a green CI. Setup, jobs, secrets and break-glass steps: `.claude/rules/deploy.md`.
