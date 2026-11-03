---
paths:
  - "infra/terraform/**"
  - ".github/workflows/**"
  - "docker-compose.yml"
  - "**/Dockerfile"
---

# Containers, CI/CD and deploying

- **Containers:** one image per service: `apps/api/Dockerfile` and `apps/ingestion/Dockerfile` (build context = repo root, because both need `packages/shared` and the root lockfile; each installs only its own workspace + `@nextera/shared` via `npm ci -w <app> -w @nextera/shared --include-workspace-root`), and `apps/web/Dockerfile` (build context = `apps/web`; Node build stage, unprivileged nginx runtime). Images are non-root, `linux/amd64` for Cloud Run, listen on `$PORT`, and contain no dev packages or secrets. The web image has no API URL baked in: it refuses to start unless `API_BASE_URL` is `https://…/api` (http only for localhost). Its nginx sends a CSP and HSTS (`max-age=31536000`, no `includeSubDomains`) on every response; the CSP's `connect-src` is `'self'` + the API origin that `docker/40-runtime-config.sh` derives from `API_BASE_URL` at startup (an nginx `map` include), `script-src 'self'` only (the production build turns off `inlineCritical`, whose inline script it would block; `autoCsp` is still experimental), `style-src 'self' 'unsafe-inline'` for the `<style>` elements Angular/Material inject. Tags: `$REGISTRY/api:$TAG`, `$REGISTRY/ingestion:$TAG`, `$REGISTRY/web:$TAG`. Compose runs `api` and `ingestion` with Cloud Run's limits (`mem_limit: 512m`, `cpus: 1`; keep them in step with `run.tf`).
- **CI/CD:** `.github/workflows/ci.yml` runs every check on PRs and `main`, including the `browser-e2e` job (compose stack + `db:seed` + Playwright, throwaway `.env`), so a failing browser test blocks deploys; `deploy.yml` runs after a green CI on `main` (or manually on `main`). It authenticates with Workload Identity Federation (no service account keys), uses only repository **variables** (nothing secret), and pins action major versions. Deploys never run concurrently.

## Image and Terraform commands

```bash
# Images -> any registry (REGISTRY/TAG from the environment; default nextera/<svc>:latest)
export REGISTRY=us-central1-docker.pkg.dev/<project>/nextera TAG=$(git rev-parse --short HEAD)
gcloud auth configure-docker us-central1-docker.pkg.dev        # once, for Artifact Registry
npm run docker:build                                            # buildx linux/amd64: docker:build:api / :ingestion / :web
npm run docker:push                                             # docker push all three
# or with compose (REGISTRY/TAG from .env; DOCKER_DEFAULT_PLATFORM=linux/amd64 on Apple Silicon for Cloud Run):
docker compose build api ingestion web && docker compose push api ingestion web

# Terraform (no local install needed)
alias tf='docker run --rm -it -v "$PWD":/w -w /w -v ~/.config/gcloud:/root/.config/gcloud hashicorp/terraform:latest'
cd infra/terraform && tf fmt -check && tf init -backend=false && tf validate && tf test   # tests: mock providers, offline
cd infra/terraform && tf init -backend-config="bucket=<state-bucket>" -backend-config="prefix=nextera/prod"
cd infra/terraform && tf plan && tf apply     # needs terraform.tfvars (copy terraform.tfvars.example)
```
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

Until the six repository variables (`GCP_PROJECT_ID`, `GCP_REGION`, `GCP_REGISTRY`, `CLOUDSQL_INSTANCE`, `GCP_WIF_PROVIDER`, `GCP_DEPLOYER_SA`) are set, `deploy.yml` skips the deploy and shows a "Deploy skipped (GCP not configured)" notice instead of failing; with only some of them set it still fails at "Check repository variables".

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
