# CLAUDE.md

This file guides Claude Code when working in this repository.

## Project overview

Take-home exercise: **wind-farm fleet monitoring**. Turbine telemetry (power, wind, rotor speed, blade pitch, gearbox temperature, every 5 minutes) is ingested from **Pub/Sub** by a **NestJS ingestion worker**, stored in **PostgreSQL** with **Prisma**, and streamed live over **Server-Sent Events** by a **NestJS API & SSE service** to an **Angular** app. The services and the app (nginx) run on **Google Cloud Run**, and the infrastructure is defined with **Terraform**. Local development mirrors it with **docker-compose**.

```
turbines → Pub/Sub "telemetry" ─push→ Ingestion Worker ─→ Postgres + Redis ─→ API & SSE ←─ Angular (Cloud Run, nginx)
                 └─ dead-letter topic after N failed deliveries                 (REST + SSE, CORS, own domain)
```

## Specialist agent

Use the `fullstack-architect` subagent ([.claude/agents/fullstack-architect.md](.claude/agents/fullstack-architect.md)) for any work on the services, the Angular app, Docker or infrastructure. It documents the architecture decisions, the patterns to follow and the gotchas already hit.

## Layout

```
apps/
  api/                  # @nextera/api        NestJS 12: GET /api/farms, GET /api/turbines/:id/telemetry,
                        #                     GET /api/turbines/:id/telemetry/stats (median/high/low per metric over the same rows),
                        #                     CRUD /api/alert-configs (alert thresholds; writes are unauthenticated for now),
                        #                     GET /api/alerts?from=&to= (flagged readings + their rules, by turbine; ≤ 31 days),
                        #                     SSE GET /api/events; CORS for the web app. Dockerfile -> image "api"
  ingestion/            # @nextera/ingestion  NestJS 12: Pub/Sub push POST /pubsub/telemetry,
                        #                     CSV upload POST /ingest/telemetry (multipart field "file"). Dockerfile -> image "ingestion"
    scripts/            #   publish-sample.ts (npm run ingest:publish)
  web/                  # Angular 21 app (separate npm project, NOT a workspace). Dockerfile (context apps/web) -> image "web":
                        #                     nginx + runtime /config.json (docker/: nginx template, API_BASE_URL check + tests)
packages/
  shared/               # @nextera/shared     Prisma schema + migrations, CSV seed data, PrismaService, EventStore, mappers;
                        #                     Dockerfile = migration runner for local compose only
  testing/              # @nextera/testing    Testcontainers global setup for e2e tests
infra/terraform/        # Cloud Run (api, ingestion, web), Pub/Sub + DLQ, Cloud SQL, Memorystore, Secret Manager,
                        # Artifact Registry, domain mappings, GitHub Actions WIF + deployer SA
.github/workflows/      # ci.yml (checks on PRs + main), deploy.yml (main: images -> migrate -> Cloud Run)
docker-compose.yml      # postgres, redis, pubsub emulator (+ init), migrate, api, ingestion, web
.env.example            # copy to .env: the ONE env file for compose, both services, Prisma and scripts
```

The repo root is an **npm workspace** (`packages/*`, `apps/api`, `apps/ingestion`). Install from the root. `apps/web` has its own `package.json`, because Angular and NestJS 12 need different TypeScript versions.

## Environments

| | Local | GCP |
|---|---|---|
| Database | compose `nextera-postgres` (host `localhost:5433`) | Cloud SQL PostgreSQL 18 |
| Redis (SSE history + fan-out) | compose `nextera-redis` (host `localhost:6380`) | Memorystore |
| Pub/Sub | compose emulator `localhost:8085`, topic `telemetry` → push to ingestion | topic `telemetry`, push subscription (OIDC) + `telemetry-dead-letter` |
| Ingestion worker | `npm run dev:ingestion` (:3001) or compose (:8081) | Cloud Run `nextera-ingestion` (IAM-only) |
| API & SSE | `npm run dev:api` (:3000) or compose (:8080) | Cloud Run `nextera-api`, `api_domain` |
| Angular | `cd apps/web && npm start` (:4200 → API on :3000), `npm run start:docker` (→ compose API on :8080), or compose `web` (:8082) | Cloud Run `nextera-web` (public; `web_url` output, `web_domain`) |
| Migrations | `npm run db:migrate` / compose `migrate` | GitHub Actions `deploy.yml`: `prisma migrate deploy` via Cloud SQL Auth Proxy, before each deploy |
| CI/CD | `npm run lint && …` (see below) | GitHub Actions (`ci.yml`, `deploy.yml`), Workload Identity Federation, `production` environment |
| Secrets | `.env` (gitignored) | Secret Manager (`database-url`, `redis-url`) |

There is exactly one local database (the compose Postgres) and one Prisma schema (`packages/shared`). Keep Postgres 18 in step with Cloud SQL (`db_version`).

## Conventions

- **TypeScript:** `strict` everywhere. NestJS 12 services are ESM, so relative imports end in `.js`.
- **Shared code:** both services import Prisma, `EventStore`, the `to*Response` mappers and the event names from `@nextera/shared`. Never duplicate them.
- **Data:** Prisma only. Migrations must be backward-compatible with the running revision (one accepted exception: `20261006233000_turbines_uuid_id_commissioned`), are committed, and are applied only by `migrate deploy`. Write column renames by hand (`RENAME COLUMN`): `migrate dev`/`migrate diff` would drop and re-add the column.
- **Events:** publish to Redis via `EventStore` only **after** the database transaction commits.
- **Data model:** `farms` → `turbines` → `telemetry`. `turbines`: UUID `id` (internal, never exposed by the API), business key `turbine_id` ('TURB001', unique; used by payloads, CSVs, API ids, SSE and URLs), `commissioned` (default false). `telemetry`: UUID id; composite FK `(turbine_id, farm_id)` → `turbines(turbine_id, farm_id)`; unique `(turbine_id, timestamp)`. `created_at` (default now(), set by Postgres) is the real insert time; `received_at` can come from the payload/CSV for backfills; neither `created_at` nor the internal ids are in API responses. "Latest" and trends use the measurement `timestamp`, never `received_at` or `created_at`. Aggregates such as `/telemetry/stats` are computed in Postgres over exactly the rows the matching list endpoint returns. `alerts_config` holds alert thresholds: `measurement_metric` (enum of the telemetry metric columns), `comparison` (`above`/`below`), `value_metric`, `alert_level` (`info`/`warn`/`error`), `enabled` (default true; disabled rules are kept but not evaluated); one rule per (metric, comparison, level). `telemetry_alerts` (PK `(telemetry_id, alert_id)`): the rules each reading triggered, a join table (not an array column) so both ids are real FKs; `telemetry_id` CASCADE, `alert_id` RESTRICT (Postgres 23001, Prisma P2003): `DELETE /api/alert-configs/:id` of a rule that readings triggered returns 409, disable it instead (`PATCH {enabled: false}`). Ingestion (Pub/Sub and CSV) evaluates the enabled rules in the insert's transaction with `triggeredAlerts` (`@nextera/shared`, strict `>`/`<`); reads `include: TELEMETRY_ALERTS_INCLUDE`, and `TelemetryResponse.alerts` (API + SSE) is the joined rules as they are now (no snapshot), worst level first. No backfill: older readings have none. UUID ids are generated by Postgres (`gen_random_uuid()`).
- **Ingestion:** payload fields and CSV uploads both use the `telemetry.csv` format. Each new reading's triggered enabled rules are stored in `telemetry_alerts` in the same transaction. CSV uploads are all-or-nothing: every error is reported by line and nothing is stored if any row is invalid. Duplicates are skipped and counted. Idempotent on `(turbine_id, timestamp)`. Anomalous readings are stored. Invalid payloads, unknown turbines and farm mismatches return 400 (→ DLQ after retries).
- **API:** DTO validation and Prisma error mapping. CORS is limited to `CORS_ORIGINS` (`http://localhost:4200` locally, plus the compose `web` origin for the compose `api`; in GCP Terraform sets `https://nextera-web-<project number>.<region>.run.app` + `web_domain`. The hashed run.app URL is not allowed: use the `web_url` output). `/api/alert-configs` writes have **no authentication yet** (known gap: add auth before production use); each write publishes `alert-config.changed` (`ALERT_CONFIG_CHANGED` in `@nextera/shared`) after the commit.
- **Angular:** zoneless, signals, `OnPush`, standalone components. Styling is **Tailwind CSS v4** utilities on top of the theme tokens in `src/styles.css` (`bg-page`, `text-muted`, `border-line` …). There is no component CSS. Tests use `data-testid`, never utility classes. The API base URL comes from `src/environments` in development; production builds have none and load it at runtime from `/config.json` (written by the container from `API_BASE_URL`). Restart `ng serve` after editing `angular.json` or `.postcssrc.json` (both are read at startup). Material: tables (`TABLE_IMPORTS`, `[appPaging]` paginators, `TableFrame` on window-high pages), `MatDialog` (the Rules page's editor/delete dialogs, typed Reactive Forms), `matButton`/`matIconButton`/`mat-button-toggle-group`, all themed by mapping `--mat-*` tokens to ours in `styles.css` (no Material theme). Stable Angular APIs only (`rxResource`, `httpResource` and Signal Forms are experimental in 21.2). `FleetShell` owns `FleetStore` (the Rules page provides its own `AlertRulesStore`), the live SSE connection and a side nav (left column on desktop, top bar with a menu toggle on phones):
  - **Farms** (`/farms`; `/` and unknown URLs redirect there), farm first: `/farms` (fleet overview: Leaflet map of all farms + farm table) → `/farms/:farmId` (map and cards of that farm's turbines) → `/farms/:farmId/turbines/:turbineId` (one ECharts candlestick chart per metric — UTC candles sized to the range (6h → 15 min, 24h → 30 min, 48h → 1 h, 7d → 4 h), hollow rising / solid falling, drag to brush a range that zooms every chart, "Reset zoom" button — plus an "Alert rules triggered" chart — rules per reading as the line, flagged readings as a level-coloured scatter overlay with a legend and the rules in the tooltip — all with a shared crosshair, a shared dataZoom time window — slider + drag/Ctrl+wheel, dashed median/high/low reference lines for the selected range, a time-range row whose window ends at the client clock, readings table; an empty window shows a message instead of charts).
  - **Turbines** (`/turbines`): every turbine with status, Commissioned (check mark or X), latest values; sortable and filterable (text, status, commissioning). No Alert column: alerts are evaluated at ingestion and shown on the turbine page's alerts chart and the Alerting History tab.
  - **Tables** are Angular Material `mat-table` with a `mat-paginator`, paged client-side from signals (`ui/paging.ts`); the farms table is not paginated.
  - **Alerting**: `/alerting` (redirects to History; tabs History and Rules), `/alerting/history` (History: `GET /api/alerts` for whole UTC days chosen with a Material date range picker (native DateAdapter), default yesterday–today; Material table with expandable rows — one summary row per turbine (latest alert time, each distinct rule as a level-coloured Material chip with its count) that expands to its readings, each with its rules as chips; 25 turbines per page) and `/alerting/rules` (Rules: CRUD for `alerts_config`).
  - **Reporting** (`/reporting`): placeholder.
  - **Staleness** uses the client clock (`NOW` token, `FleetStore` ticks every minute): more than 15/30/60 min since the latest measurement → "No data in 15/30/60 min" (yellow/orange/red pills, `fleet/staleness.ts`); only `ok` turbines count as reporting.
- **Containers:** one image per service: `apps/api/Dockerfile` and `apps/ingestion/Dockerfile` (build context = repo root, because both need `packages/shared` and the root lockfile; each installs only its own workspace + `@nextera/shared` via `npm ci -w <app> -w @nextera/shared --include-workspace-root`), and `apps/web/Dockerfile` (build context = `apps/web`; Node build stage, unprivileged nginx runtime). Images are non-root, `linux/amd64` for Cloud Run, listen on `$PORT`, and contain no dev packages or secrets. The web image has no API URL baked in: it refuses to start unless `API_BASE_URL` is `https://…/api` (http only for localhost). Tags: `$REGISTRY/api:$TAG`, `$REGISTRY/ingestion:$TAG`, `$REGISTRY/web:$TAG`.
- **Infrastructure:** change GCP only through `infra/terraform`. Run `terraform fmt -check` + `validate` before committing.
- **CI/CD:** `.github/workflows/ci.yml` runs every check on PRs and `main`; `deploy.yml` runs after a green CI on `main` (or manually on `main`). It authenticates with Workload Identity Federation (no service account keys), uses only repository **variables** (nothing secret), and pins action major versions. Deploys never run concurrently.
- **Never commit:** secrets, `.env`, `*.tfvars` or Terraform state.
- **Tests:** every change includes tests.
  - **Backend unit tests** (`*.spec.ts`, Vitest) mock Prisma with `vitest-mock-extended`.
  - **Backend e2e tests** (`test/*.e2e-spec.ts`) run against Testcontainers Postgres 18 + Redis 8 (Docker required). Migration tests live in `packages/shared/test` (existing data survives the migration, no drift).
  - **Angular tests** use Vitest + TestBed with a `FakeEventSource`. ECharts (SVG renderer) runs in jsdom without a canvas mock (`src/testing/test-setup.ts` stubs `ResizeObserver`). jsdom has no layout, so verify chart rendering in a browser.

## Common commands

```bash
# First time
cp .env.example .env
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
npm run db:seed                               # load prisma/data/*.csv (idempotent)
npm run lint && npm run typecheck && npm test && npm run test:e2e && npm run build

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
                                      # GCP_REGISTRY, CLOUDSQL_INSTANCE
```

Until the first deploy, the Cloud Run services (including `nextera-web`) serve Terraform's placeholder image.

Then push to `main` (or run **Deploy** manually).

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
```

To redeploy only the web app: `REGISTRY=$REG TAG=$SHA npm run docker:build:web && docker push $REG/web:$SHA`, then the `nextera-web` line above. Its `API_BASE_URL` stays as Terraform set it.

Create the DNS records from the `api_dns_records` and `web_dns_records` outputs. The managed certificates provision once DNS resolves.
