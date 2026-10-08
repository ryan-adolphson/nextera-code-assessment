# CLAUDE.md

This file guides Claude Code when working in this repository.

## Project overview

Take-home exercise: **wind-farm fleet monitoring**. Turbine telemetry (power, wind, rotor speed, blade pitch, gearbox temperature, every 5 minutes) is ingested from **Pub/Sub** by a **NestJS ingestion worker**, stored in **PostgreSQL** with **Prisma**, and streamed live over **Server-Sent Events** by a **NestJS API & SSE service** to an **Angular** app. The services and the app (nginx) run on **Google Cloud Run**, and the infrastructure is defined with **Terraform**. Local development mirrors it with **docker-compose**.

```
turbines → Pub/Sub "telemetry" ─push→ Ingestion Worker ─→ Postgres + Redis ─→ API & SSE ←─ Angular (Cloud Run, nginx)
                 └─ dead-letter topic after N failed deliveries                 (REST + SSE, CORS, own domain)
```

## Specialist agents

Eight subagents in `.claude/agents/` hold the patterns to follow and the gotchas already hit. Use them for work in their area:
- **`angular-engineer`** ([.claude/agents/angular-engineer.md](.claude/agents/angular-engineer.md)): anything in `apps/web` (pages, Material, Tailwind, charts, maps, `FleetStore`, the web image, Angular tests). Preloads the `angular-developer` skill.
- **`nestjs-engineer`** ([.claude/agents/nestjs-engineer.md](.claude/agents/nestjs-engineer.md)): `apps/api`, `apps/ingestion` and `packages/shared` (endpoints, DTOs, Prisma and migrations, ingestion, `EventStore`/SSE, the service images, backend tests). Preloads the `nestjs-professional-software-engineering` and `nestjs-features-performance` skills.
- **`fullstack-architect`** ([.claude/agents/fullstack-architect.md](.claude/agents/fullstack-architect.md)): architecture, changes that span the backend and the web app (API/SSE contracts, the data model end to end), docker-compose, Cloud Run, Terraform, and the GCP side of CI/CD (WIF, deployer SA). Preloads the `terraform-style-guide`, `terraform-test` and `cloud-run-basics` skills.
- **`auth-engineer`** ([.claude/agents/auth-engineer.md](.claude/agents/auth-engineer.md)): authentication and authorization end to end (JWT access tokens, login/logout, password hashing, NestJS guards and `@Roles` with viewer < owner < admin, the Angular login page, interceptor and route guards, SSE auth, the `users` model, signing keys). Preloads the `nestjs-features-performance`, `nestjs-professional-software-engineering` and `angular-developer` skills.
- **`cicd-engineer`** ([.claude/agents/cicd-engineer.md](.claude/agents/cicd-engineer.md)): CI/CD: the GitHub Actions workflows (`ci.yml`, `deploy.yml`), their jobs, permissions, concurrency and caching, the deploy pipeline, repository variables and the `production` environment, workflow security and efficiency reviews. The GCP side (WIF, deployer SA, `github.tf`) stays with `fullstack-architect`. Preloads the `github-actions-hardening` and `github-actions-efficiency` skills.
- **`playwright-test-planner`**, **`playwright-test-generator`**, **`playwright-test-healer`** (Playwright's own generated agents; don't edit them): the planner explores the app and writes plans to `e2e/specs/*.md`, the generator turns plan scenarios into `e2e/tests/**`, the healer debugs and fixes failing tests. They need the `playwright-test` MCP server (`.mcp.json`) and the running compose stack + `db:seed` fixture (see **Tests**).

**Skills:** installed with `npx skills` into `.agents/skills/` (pinned in `skills-lock.json`) and symlinked into `.claude/skills/`, where Claude Code discovers them. After `npx skills add`, symlink any new skill the same way. The agent files take precedence over the general skill guidance (e.g. no component CSS, Cloud Run + Pub/Sub push).

## Layout

```
apps/
  api/                  # @nextera/api        NestJS 12: GET /api/farms, GET /api/turbines/:id/telemetry,
                        #                     GET /api/turbines/:id/telemetry/stats (median/high/low per metric over the same rows),
                        #                     CRUD /api/alert-configs (alert thresholds; writes need owner),
                        #                     GET /api/alerts?from=&to= (flagged readings + their rules, by turbine; ≤ 31 days),
                        #                     GET /api/reports/telemetry?farmId=|turbineId=&from=&to= (all readings + alerts; ≤ 31 days),
                        #                     SSE GET /api/events; POST /api/auth/login, GET /api/auth/me (sign-in, roles);
                        #                     CORS for the web app. Dockerfile -> image "api"
  ingestion/            # @nextera/ingestion  NestJS 12: Pub/Sub push POST /pubsub/telemetry,
                        #                     CSV upload POST /ingest/telemetry (multipart field "file"). Dockerfile -> image "ingestion"
    src/demo-feed/      #   live demo feed, not part of the worker: `node dist/demo-feed/main.js [--once]` in the same image
    scripts/            #   publish-sample.ts (npm run ingest:publish), demo-feed.ts (npm run demo:feed)
  mcp/                  # @nextera/mcp       Local stdio MCP server (plain Node, @modelcontextprotocol/sdk), read-only fleet tools
                        #                     for Claude: list_farms, get_turbine, get_telemetry, get_telemetry_stats,
                        #                     list_alerts, list_alert_rules, get_report_summary. Registered in .mcp.json; no image
  web/                  # Angular 22 app (separate npm project, NOT a workspace). Dockerfile (context apps/web) -> image "web":
                        #                     nginx + runtime /config.json (docker/: nginx template, API_BASE_URL check + tests)
packages/
  shared/               # @nextera/shared     Prisma schema + migrations, CSV seed data, PrismaService, EventStore, mappers,
                        #                     read queries (src/wind/queries.ts: used by the API and the MCP server),
                        #                     demo data (src/seed: demo fleet + telemetry generator; prisma/seed-demo.ts);
                        #                     Dockerfile = migration runner for local compose only
  testing/              # @nextera/testing    Testcontainers global setup for e2e tests
e2e/                    # Playwright browser E2E (separate npm project, NOT a workspace) against the compose stack (web :8082):
                        #   playwright.config.ts (projects read-only + data), tests/seed.spec.ts (fixed clock + sign-in;
                        #   the agents' seed), tests/data/** ([DATA] tests, serial), specs/*.md (test plans)
infra/terraform/        # Cloud Run (api, ingestion, web), Pub/Sub + DLQ, Cloud SQL, Memorystore, Secret Manager,
                        # Artifact Registry, domain mappings, GitHub Actions WIF + deployer SA,
                        # optional demo feed (demo-feed.tf: Cloud Run Job + Cloud Scheduler, demo_feed_enabled)
.github/workflows/      # ci.yml (checks + browser E2E on PRs + main), deploy.yml (main: images -> migrate -> Cloud Run [-> demo feed job])
docker-compose.yml      # postgres, redis, pubsub emulator (+ init), migrate, api, ingestion, web, demo-feed
.env.example            # copy to .env: the ONE env file for compose, both services, Prisma and scripts
.mcp.json               # MCP servers for Claude Code: playwright-test (e2e agents) and nextera (apps/mcp, read-only fleet tools)
```

The repo root is an **npm workspace** (`packages/*`, `apps/api`, `apps/ingestion`, `apps/mcp`). Install from the root. `apps/web` has its own `package.json`, because Angular and NestJS 12 need different TypeScript versions.

## Environments

| | Local | GCP |
|---|---|---|
| Database | compose `nextera-postgres` (host `localhost:5433`) | Cloud SQL PostgreSQL 18 |
| Redis (SSE history + fan-out) | compose `nextera-redis` (host `localhost:6380`) | Memorystore |
| Pub/Sub | compose emulator `localhost:8085`, topic `telemetry` → push to ingestion | topic `telemetry`, push subscription (OIDC) + `telemetry-dead-letter` |
| Ingestion worker | `npm run dev:ingestion` (:3001) or compose (:8081) | Cloud Run `nextera-ingestion` (IAM-only) |
| API & SSE | `npm run dev:api` (:3000) or compose (:8080) | Cloud Run `nextera-api`, `api_domain` |
| Angular | `cd apps/web && npm start` (:4200 → API on :3000), `npm run start:docker` (→ compose API on :8080), or compose `web` (:8082) | Cloud Run `nextera-web` (public; `web_url` output, `web_domain`) |
| Demo feed (off by default) | `npm run demo:feed` or compose `demo-feed`, both on `DEMO_FEED_ENABLED=true` in `.env` | Cloud Run Job `nextera-demo-feed` + Cloud Scheduler every 5 min (`demo_feed_enabled`, `demo_feed_paused`) |
| Migrations | `npm run db:migrate` / compose `migrate` | GitHub Actions `deploy.yml`: `prisma migrate deploy` via Cloud SQL Auth Proxy, before each deploy |
| CI/CD | `npm run lint && …` (see below) | GitHub Actions (`ci.yml`, `deploy.yml`), Workload Identity Federation, `production` environment |
| Secrets | `.env` (gitignored) | Secret Manager (`database-url`, `redis-url`, `jwt-secret`) |

There is exactly one local database (the compose Postgres) and one Prisma schema (`packages/shared`). Keep Postgres 18 in step with Cloud SQL (`db_version`).

## Conventions

- **TypeScript:** `strict` everywhere. NestJS 12 services are ESM, so relative imports end in `.js`.
- **Shared code:** both services import Prisma, `EventStore`, the `to*Response` mappers and the event names from `@nextera/shared`; the API and the MCP server read through the shared queries (`src/wind/queries.ts`: `listFarms`, `turbineTelemetry`, `telemetryStats`, `alertsInRange`, `reportTelemetry`, …), which throw `QueryNotFoundError`/`QueryInputError` that the API maps to 404/400; ingestion and the demo seed store readings with `insertTelemetryWithAlerts` / `storeAlerts` / `enabledAlertRules`; the demo seed and feed share `DEMO_TURBINES`, `DEMO_SEED`, `DEMO_ANOMALIES` and `generateTelemetry` (deterministic, so the feed continues the seeded curve). Never duplicate them.
- **Data:** Prisma only. Migrations must be backward-compatible with the running revision (one accepted exception: `20261006233000_turbines_uuid_id_commissioned`), are committed, and are applied only by `migrate deploy`. Write column renames by hand (`RENAME COLUMN`): `migrate dev`/`migrate diff` would drop and re-add the column.
- **Events:** publish to Redis via `EventStore` only **after** the database transaction commits.
- **Data model:** `farms` → `turbines` → `telemetry`. `turbines`: UUID `id` (internal, never exposed by the API), business key `turbine_id` ('TURB001', unique; used by payloads, CSVs, API ids, SSE and URLs), `commissioned` (default false). `telemetry`: UUID id; composite FK `(turbine_id, farm_id)` → `turbines(turbine_id, farm_id)`; unique `(turbine_id, timestamp)`. `created_at` (default now(), set by Postgres) is the real insert time; `received_at` can come from the payload/CSV for backfills; neither `created_at` nor the internal ids are in API responses. "Latest" and trends use the measurement `timestamp`, never `received_at` or `created_at`. Aggregates such as `/telemetry/stats` are computed in Postgres over exactly the rows the matching list endpoint returns. `alerts_config` holds alert thresholds: `measurement_metric` (enum of the telemetry metric columns), `comparison` (`above`/`below`), `value_metric`, `alert_level` (`info`/`warn`/`error`), `enabled` (default true; disabled rules are kept but not evaluated); one rule per (metric, comparison, level). `telemetry_alerts` (PK `(telemetry_id, alert_id)`): the rules each reading triggered, a join table (not an array column) so both ids are real FKs; `telemetry_id` CASCADE, `alert_id` RESTRICT (Postgres 23001, Prisma P2003): `DELETE /api/alert-configs/:id` of a rule that readings triggered returns 409, disable it instead (`PATCH {enabled: false}`). Ingestion (Pub/Sub and CSV) evaluates the enabled rules in the insert's transaction with `triggeredAlerts` (`@nextera/shared`, strict `>`/`<`); reads `include: TELEMETRY_ALERTS_INCLUDE`, and `TelemetryResponse.alerts` (API + SSE) is the joined rules as they are now (no snapshot), worst level first. No backfill: older readings have none. `users`: UUID `id` (the JWT `sub`), unique normalised (trimmed, lower-case) `email`, `password_hash` (argon2id), `role` (enum `role`: `viewer`/`owner`/`admin`), `active` (default true), `created_at`, `updated_at`; rows come only from `npm run db:seed` (or `db:seed:demo`). UUID ids are generated by Postgres (`gen_random_uuid()`).
- **Demo data:** `npm run db:seed` stays the fixed fixture (the CSVs: TURB001/TURB002, 2 days in Jan 2026) that tests rely on. `npm run db:seed:demo` is for demos: the fixture farms, 25 `DEMO_TURBINES` (TURB001–TURB025, 2–3 per farm), the default rules (gearbox > 100 °C error, power < 100 kW warn, pitch > 30° info; existing rules kept), 72 h of generated telemetry ending now with `telemetry_alerts`, and the test users. Idempotent: a re-run tops up to now (`SEED_NOW` ISO, `SEED_HOURS` 1–744 override). Anomalies, relative to the seed's end: TURB001 frozen at 0 kW in strong wind (−50 h), TURB002 pitch spike (−30 h) and gearbox stuck at 126.5 °C (−6 h), TURB013 stopped (last reading −40 min; the feed never publishes it, so it goes stale), TURB008 gap (−20 h), late `received_at` on TURB005/014/021. The live feed (`apps/ingestion/src/demo-feed`) publishes one reading per demo turbine (24, not TURB013) per tick at the current 5-min boundary to `PUBSUB_TOPIC`, through Pub/Sub → ingestion like a real turbine (alerts, SSE). Env only: `DEMO_FEED_ENABLED` (must be `true`, else it logs "Demo feed disabled" and exits 0), `DEMO_FEED_INTERVAL_SECONDS` (300), `--once`/`DEMO_FEED_ONCE=true`; no DB, Redis or JWT. **Run `db:seed:demo` before enabling the feed:** the fixture has only TURB001/TURB002, readings for unknown turbines get 400, and the emulator (no DLQ) redelivers them forever (GCP: DLQ after `pubsub_max_delivery_attempts`).
- **Ingestion:** payload fields and CSV uploads both use the `telemetry.csv` format. Each new reading's triggered enabled rules are stored in `telemetry_alerts` in the same transaction. CSV uploads are all-or-nothing: every error is reported by line and nothing is stored if any row is invalid. Duplicates are skipped and counted. Idempotent on `(turbine_id, timestamp)`. Anomalous readings are stored. Invalid payloads, unknown turbines and farm mismatches return 400 (→ DLQ after retries).
- **API:** DTO validation and Prisma error mapping. CORS is limited to `CORS_ORIGINS` (`http://localhost:4200` locally, plus the compose `web` origin for the compose `api`; in GCP Terraform sets `https://nextera-web-<project number>.<region>.run.app` + `web_domain`. The hashed run.app URL is not allowed: use the `web_url` output). Every route needs a signed-in user unless it is `@Public()` (see **Auth**); each `/api/alert-configs` write publishes `alert-config.changed` (`ALERT_CONFIG_CHANGED` in `@nextera/shared`) after the commit.
- **Auth (MVP, owned by `auth-engineer`):** `POST /api/auth/login` (`{ email, password }` → `{ accessToken, expiresAt, user: { email, role } }`; every failure is 401 "Invalid email or password") issues one **HS256 JWT valid for 24 h** (`jose`; claims `sub` = user id, `role`, `iss` `JWT_ISSUER`, `aud` `JWT_AUDIENCE`, `iat`, `exp`, `jti`; algorithm pinned on verify, 30 s clock tolerance). No refresh tokens or revocation list: the `AuthGuard` reloads the user on every request, so deactivating a user or changing a role applies at once. Passwords are argon2id (m = 19 MiB, t = 2, p = 1, `PASSWORD_HASH_OPTIONS` in `@nextera/shared`); unknown emails verify a dummy hash. Global guards in `AppModule` (default deny): `AuthGuard` (Bearer header; `?access_token=` only on `GET /api/events`, marked `@AllowQueryToken()`, since `EventSource` can't send headers) answers a missing, invalid or expired token or an inactive user with **401** + `WWW-Authenticate: Bearer`; `RolesGuard` reads `@Roles(minRole)` (handler, then controller; routes without it are admin-only) and answers a too-low role with **404**, the exact body of an unknown route (`Cannot GET /api/...`). Roles are hierarchical, `viewer < owner < admin` (`Role`, `ROLE_RANK`, `hasRole` in `@nextera/shared`; mirrored by hand in `apps/web/src/app/core/auth/roles.ts`). Access matrix (prefix `/api`): public `GET /health/live`, `/health/ready`, `POST /auth/login`; viewer `GET /auth/me`, `/farms`, `/turbines/:id/telemetry` (+ `/stats`), `/events`, `/alerts`, `/alert-configs` (+ `/:id`); owner `POST`/`PATCH`/`DELETE /alert-configs`, `GET /reports/telemetry`; admin everything. The SSE stream ends when its token expires. The ingestion worker stays IAM-only (no user auth). CORS allows the `Authorization` header (no cookies, so no `credentials`). The web app keeps the session in **localStorage** for at most 24 h (`AuthStore`), adds the Bearer token to `API_BASE_URL` requests only (`authInterceptor`, a 401 → sign out → `/login`), guards `FleetShell` with `canMatch` (`/login` is outside it, so no fleet load or SSE before sign-in) and `/reporting` with `roleGuard('owner')`, and hides Reporting in the nav and Add/Edit/Delete on the Rules page for viewers. **Accepted PoC trade-offs:** a token in localStorage is readable by XSS; the SSE token in the query string appears in Cloud Run request logs; tokens can't be revoked before their 24 h end except by deactivating the user or rotating `JWT_SECRET` (which ends every session); no login rate limiting yet. Env: `JWT_SECRET` (≥ 32 characters, no default, `openssl rand -base64 48`; Secret Manager `jwt-secret` in GCP), `JWT_ISSUER` (default `nextera-api`), `JWT_AUDIENCE` (default `nextera-web`); `SEED_USER_PASSWORD` for the seed. Test users from `npm run db:seed`: `viewer@nextera.local`, `owner@nextera.local`, `admin@nextera.local`, all with `SEED_USER_PASSWORD`.
- **MCP server (`apps/mcp`):** local stdio only (started by the MCP client from `.mcp.json` / Claude Desktop), never deployed. **Read-only, and it stays that way:** tools only read through the shared queries, and every pooled connection sets `-c default_transaction_read_only=on`, so any write fails in Postgres with SQLSTATE 25006; never add a tool that writes, and never drop that setting. In GCP, point `MCP_DATABASE_URL` at a role that has only `SELECT`. stdout carries only JSON-RPC: log to stderr. It reads `MCP_DATABASE_URL`, else `DATABASE_URL` (repo-root `.env`), pool `max: 2`. Tool arguments mirror the API's limits (`limit` ≤ 2016, ranges ≤ 31 days, timestamps via `timestampProblem`), and errors (unknown turbine, bad range, database failure) are `isError` results, never a crash.
- **Angular:** zoneless, signals, standalone components; OnPush is the default since Angular 22, so don't set `changeDetection`. Styling is **Tailwind CSS v4** utilities on top of the theme tokens in `src/styles.css` (`bg-page`, `text-muted`, `border-line` …). There is no component CSS. Tests use `data-testid`, never utility classes. The API base URL comes from `src/environments` in development; production builds have none and load it at runtime from `/config.json` (written by the container from `API_BASE_URL`). Restart `ng serve` after editing `angular.json` or `.postcssrc.json` (both are read at startup). Material: tables (`TABLE_IMPORTS`, `[appPaging]` paginators, `TableFrame` on window-high pages), `MatDialog` (the Rules page's editor/delete dialogs), `matButton`/`matIconButton`/`mat-button-toggle-group`, all themed by mapping `--mat-*` tokens to ours in `styles.css` (no Material theme). Stable Angular APIs only. Loads use `rxResource` through `latestLoad` (`ui/latest-load.ts`: History, Reporting, `AlertRulesStore`). Forms are Signal Forms (`@angular/forms/signals`: `form()` over a model signal, schema validators, `[formField]` on Material controls, `[formRoot]` on the `<form>`; Material 22.2 reads the field state for its error state); no Reactive Forms. Native selects bound with `[formField]` update on `input`, so specs dispatch `input` (and `change`) like a browser. Testing a resource: it sends its request on the next change detection and is a PendingTasks entry while loading, so `fixture.whenStable()` and Material harness actions hang until its request is flushed: call `TestBed.tick()` before `expectOne`, flush, then wait a task (`setTimeout`) or `whenStable()`. Dates: date-fns 4 with the `@date-fns/utc` context (`{ in: utc }`), helpers in `core/utc-days.ts` and `charts/scales.ts`. `FleetShell` owns `FleetStore` (the Rules page provides its own `AlertRulesStore`), the live SSE connection and a side nav (left column on desktop, top bar with a menu toggle on phones):
  - **Farms** (`/farms`; `/` and unknown URLs redirect there), farm first: `/farms` (fleet overview: Leaflet map of all farms + farm table) → `/farms/:farmId` (map of that farm's turbines + the same turbines table as `/turbines`, scoped to the farm, without the Farm column) → `/farms/:farmId/turbines/:turbineId` (one ECharts candlestick chart per metric — UTC candles sized to the range (6h → 15 min, 24h → 30 min, 48h → 1 h, 7d → 4 h), hollow rising / solid falling, drag to brush a range that zooms every chart, "Reset zoom" button — plus an "Alert rules triggered" chart — rules per reading as the line, flagged readings as a level-coloured scatter overlay with a legend and the rules in the tooltip — all with a shared crosshair, a shared dataZoom time window — slider + drag/Ctrl+wheel, dashed median/high/low reference lines for the selected range, a time-range row whose window ends at the client clock, readings table whose Alerts column shows one "Level: count" pill per level triggered, worst first, as on History, with every rule in a tooltip; an empty window shows a message instead of charts).
  - **Turbines** (`/turbines`): every turbine with status, Commissioned (check mark or X), latest values; sortable and filterable (text, status, commissioning). The table is the shared `TurbineTable` (`fleet/turbine-table.ts`), also used by the farm page. No Alert column: alerts are evaluated at ingestion and shown on the turbine page's alerts chart and the Alerting History tab.
  - **Tables** are Angular Material `mat-table` with a `mat-paginator`, paged client-side from signals (`ui/paging.ts`); the farms table is not paginated.
  - **Alerting**: `/alerting` (redirects to History; tabs History and Rules), `/alerting/history` (History: `GET /api/alerts` for whole UTC days chosen with a Material date range picker (native DateAdapter), default yesterday–today; Material table with expandable rows — one summary row per turbine (farm, latest alert, an Alerts column with one "Level: count" pill per level: every rule each reading triggered, worst level first) that expands to its readings, each with its rules as level-coloured Material chips; 25 turbines per page) and `/alerting/rules` (Rules: CRUD for `alerts_config`).
  - **Reporting** (`/reporting`, proof of concept; owner and admin only): a farm or turbine from a Material autocomplete (Farms / Turbines groups) and a required Material date range (whole UTC days, ≤ 31) → one `GET /api/reports/telemetry` → summary tiles, one `LineChart` per metric (a farm: power summed, the rest averaged per time) + an alerts chart, a paginated readings table, and a CSV download built in the browser (telemetry.csv columns + `alerts`).
  - **Staleness** uses the client clock (`NOW` token, `FleetStore` ticks every minute): more than 15/30/60 min since the latest measurement → "No data in 15/30/60 min" (yellow/orange/red pills, `fleet/staleness.ts`); only `ok` turbines count as reporting.
- **Containers:** one image per service: `apps/api/Dockerfile` and `apps/ingestion/Dockerfile` (build context = repo root, because both need `packages/shared` and the root lockfile; each installs only its own workspace + `@nextera/shared` via `npm ci -w <app> -w @nextera/shared --include-workspace-root`), and `apps/web/Dockerfile` (build context = `apps/web`; Node build stage, unprivileged nginx runtime). Images are non-root, `linux/amd64` for Cloud Run, listen on `$PORT`, and contain no dev packages or secrets. The web image has no API URL baked in: it refuses to start unless `API_BASE_URL` is `https://…/api` (http only for localhost). Its nginx sends a CSP and HSTS (`max-age=31536000`, no `includeSubDomains`) on every response; the CSP's `connect-src` is `'self'` + the API origin that `docker/40-runtime-config.sh` derives from `API_BASE_URL` at startup (an nginx `map` include), `script-src 'self'` only (the production build turns off `inlineCritical`, whose inline script it would block; `autoCsp` is still experimental), `style-src 'self' 'unsafe-inline'` for the `<style>` elements Angular/Material inject. Tags: `$REGISTRY/api:$TAG`, `$REGISTRY/ingestion:$TAG`, `$REGISTRY/web:$TAG`.
- **Infrastructure:** change GCP only through `infra/terraform`. Run `terraform fmt -check` + `validate` before committing.
- **CI/CD:** `.github/workflows/ci.yml` runs every check on PRs and `main`, including the `browser-e2e` job (compose stack + `db:seed` + Playwright, throwaway `.env`), so a failing browser test blocks deploys; `deploy.yml` runs after a green CI on `main` (or manually on `main`). It authenticates with Workload Identity Federation (no service account keys), uses only repository **variables** (nothing secret), and pins action major versions. Deploys never run concurrently.
- **Never commit:** secrets, `.env`, `*.tfvars` or Terraform state.
- **Tests:** every change includes tests.
  - **Backend unit tests** (`*.spec.ts`, Vitest) mock Prisma with `vitest-mock-extended`.
  - **Backend e2e tests** (`test/*.e2e-spec.ts`) run against Testcontainers Postgres 18 + Redis 8 (Docker required). Migration tests live in `packages/shared/test` (existing data survives the migration, no drift).
  - **Angular tests** use Vitest + TestBed with a `FakeEventSource`. ECharts (SVG renderer) runs in jsdom without a canvas mock (`src/testing/test-setup.ts` stubs `ResizeObserver`). jsdom has no layout, so verify chart rendering in a browser.
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
npm run db:seed:demo                          # demo data instead: 25 turbines, default rules, 72 h up to now + anomalies (re-run tops up; SEED_HOURS/SEED_NOW)
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
npm run build                                 # production build (the API URL is runtime config, not built in)

# Terraform (no local install needed)
alias tf='docker run --rm -it -v "$PWD":/w -w /w -v ~/.config/gcloud:/root/.config/gcloud hashicorp/terraform:latest'
cd infra/terraform && tf fmt -check && tf init -backend=false && tf validate
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

**API URL of the web app:** runtime config, not build-time. Terraform sets `API_BASE_URL` (`api_url` output + `/api`) on `nextera-web`. At startup `apps/web/docker/40-runtime-config.sh` validates it (https, ends in `/api`, not an `example.*` placeholder) and writes `/config.json`, which `src/main.ts` fetches before bootstrapping. A bad value stops the container, so Cloud Run keeps serving the previous revision. Changing `api_domain` only needs `tf apply`, no rebuild.

The workflow-level `concurrency` group `deploy-production` makes sure two deploys (and two migrations) never overlap. Re-run a deploy with **Actions → Deploy → Run workflow** on `main`.

### One-time setup

```bash
# 1. Infrastructure: set github_repository = "owner/repo" in terraform.tfvars, then
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
```

To redeploy only the web app: `REGISTRY=$REG TAG=$SHA npm run docker:build:web && docker push $REG/web:$SHA`, then the `nextera-web` line above. Its `API_BASE_URL` stays as Terraform set it.

Create the DNS records from the `api_dns_records` and `web_dns_records` outputs. The managed certificates provision once DNS resolves.
