# Load test: harness smoke run

**This run proves the harness works. It says nothing about capacity.** It sent a low, fixed rate to one instance of each service on a laptop. No limit was looked for or found.

## What was run

Run on 2026-11-03 against a throwaway compose stack (`load/docker-compose.yml`): Postgres, Redis, `migrate`, `ingestion` and `api`.

| Scenario | File | Load | Target |
|---|---|---|---|
| Ingestion | `load/ingest.yml` | 5 arrivals per second for 30 s | `POST /pubsub/telemetry`, one Pub/Sub push envelope per arrival, 200-turbine fleet |
| Reads | `load/reads.yml` | 2 arrivals per second for 15 s, 3 requests each, after one sign-in as `viewer@nextera.local` | `GET /api/farms`, `/api/turbines/TURB001/telemetry`, `/api/farms/FARM01/telemetry/daily` |

**Machine:** Apple M1 Pro (10 CPUs, 16 GB), macOS 15.7.7, Node 24.15.0, Artillery 2.0.34. Docker Desktop 29.8.2 (linux/arm64 VM with 10 CPUs and 7.7 GB). `api` and `ingestion` were limited to 1 CPU and 512 MB, as in `docker-compose.yml`. Postgres 18.4 and Redis 8.10.2. Artillery ran on the same machine as the stack.

## Results

From the saved reports: [ingestion](../load/results/smoke-2026-11-03-ingest.json), [reads](../load/results/smoke-2026-11-03-reads.json), [stored-row check](../load/results/smoke-2026-11-03-check.json).

| | Ingestion | Reads |
|---|---|---|
| Requests sent | 150 | 90 |
| Responses | 150 | 90 |
| Status codes | 204: 150 | 200: 90 |
| Other codes and errors | none | none |
| Failed virtual users | 0 | 0 |
| Response time p50 | 8.9 ms | 8.9 ms |
| Response time p95 | 18 ms | 22 ms |
| Response time p99 | 23.8 ms | 63.4 ms |
| Response time max | 62 ms | 68 ms |

**Stored rows:** 150 sent, 150 acknowledged, 150 stored: **they match**. None landed in Unallocated. Time to store (see the limits below): p50 7 ms, p95 15 ms, max 69 ms.

**Re-runs:** these are the final runs on one stack, after ingestion ran twice and reads three times. Two script mistakes were fixed along the way, and neither was an app bug:
- The first reads run got 401 on all 90 requests, because the token header was under `config.defaults`, which Artillery templates before sign-in. The `ensure` check failed the run as intended.
- The first ingestion run stored 150 of 150 but used only 30 of the 200 turbines, because every worker started at the first turbine. Workers now start at different places in the fleet, and the final run reported from 150 turbines.

## Limits of these numbers

- **Time to store** is `created_at - received_at`. `created_at` defaults to `now()`, the start of the insert's transaction, so the figure leaves out the insert and the commit. It also compares two clocks: `received_at` is the publish time from the host running Artillery, and `created_at` comes from the Postgres container.
- **Small sample:** with 90 to 150 requests, p99 and max rest on one or two requests.
- **Low rate:** at 5 per second, nothing was near saturation, so these response times don't predict behaviour under load.
- **Local-database guard:** `load:setup` and `load:check` accept only a `LOAD_DATABASE_URL` on localhost, and also reject a remote `?host=` or `?hostaddr=`. They can't detect a TCP proxy listening on localhost, such as the Cloud SQL Auth Proxy, so don't run them with one pointed at a real database.

## Planned rates: not yet run

Steady is the fleet size ÷ 300 s, since each turbine reports every 5 minutes. Burst is a proposed worst case: the whole fleet reporting within 30 s.

| Turbines | Steady | Burst | Status |
|---|---|---|---|
| 200 | 0.67 per second | 6.7 per second | not yet run |
| 2,000 | 6.7 per second | 67 per second | not yet run |
| 10,000 | 33 per second | 333 per second | not yet run |

The smoke run's 5 per second is not one of these runs: it lasted 30 s, not a full 300 s reporting cycle.

To run one, set the fleet and override the phase (here, 2,000 turbines steady):

```bash
LOAD_FLEET_SIZE=2000 npm run load:setup
LOAD_FLEET_SIZE=2000 npm run load:ingest -- --overrides '{"config":{"phases":[{"duration":300,"arrivalCount":2000}]}}'
```

## Not covered

- **Pub/Sub itself:** the test posts directly to the ingestion worker, so there's no delivery, retry, backoff or dead-letter behaviour.
- **SSE:** no open streams and no fan-out to clients.
- **Multiple ingestion instances:** one worker, with no scaling and no concurrent instances.
- **Real Cloud Run and Cloud SQL:** no cold starts, autoscaling, network latency or managed database limits.

## How to repeat it

Artillery is its own npm project in `load/` (like `e2e/`), so its dependencies stay out of the root lockfile and the service images. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` matters: without it, the install downloads about 550 MB of Chromium that this harness doesn't use.

```bash
npm ci                                                      # root: @nextera/shared and vitest
(cd load && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci)

# Throwaway secrets and targets, in this shell only
export LOAD_POSTGRES_PASSWORD=$(openssl rand -hex 24) LOAD_REDIS_PASSWORD=$(openssl rand -hex 24)
export LOAD_JWT_SECRET=$(openssl rand -hex 32) SEED_USER_PASSWORD=$(openssl rand -hex 16)
export LOAD_DATABASE_URL="postgresql://nextera:$LOAD_POSTGRES_PASSWORD@localhost:15433/nextera?schema=public"
export LOAD_API_URL=http://localhost:18080 LOAD_INGESTION_URL=http://localhost:18081

docker compose -f load/docker-compose.yml up -d --wait --build
DATABASE_URL="$LOAD_DATABASE_URL" npm run db:seed           # the fixture and test users; without this DATABASE_URL it seeds .env's database
npm run load:setup                                          # the 200-turbine fleet; refuses a non-local database
npm run load:ingest                                         # writes load/results/ingest.json
npm run load:reads                                          # writes load/results/reads.json
npm run load:check                                          # compares stored rows; writes load/results/check.json, exit 1 on a mismatch

# Remove it. -p needs no secrets, so it works from a new shell. Avoid --rmi all: it also targets the postgres and redis images the main stack uses.
docker compose -p nextera-load down -v --remove-orphans
docker rmi nextera-load/api:smoke nextera-load/ingestion:smoke nextera-load/migrate:smoke
```

`load:ingest` and `load:reads` exit non-zero if any response isn't the expected status. Only `load/results/smoke-*.json` is kept in git; copy a run to that name to keep it. `npm run load:test` runs the message builder's unit test; the root `npm test` doesn't include it. None of this runs in CI.

## Next step

Run it against a deployed environment. The worker is IAM-only there, so `POST /pubsub/telemetry` needs an identity token with `run.invoker`, or the test should publish to the real topic so that Pub/Sub is covered too. `load:setup` and `load:check` refuse remote databases by design and would need a deliberate way to reach one.
