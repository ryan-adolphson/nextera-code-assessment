# Load test

Three runs so far: a [harness smoke run](#smoke-run-2026-11-03) that says nothing about capacity, a [baseline](#baseline-2026-11-04) that found the limits of one instance on a laptop, and a [rerun after the fixes](#after-the-fixes-2026-11-04).

## After the fixes: 2026-11-04

The same stack, machine and conditions as the baseline (the main compose stack was running here too), after adding the `/api/farms` cache and ingestion group commit with a queue limit (`INGEST_BATCH_MAX` 100, `INGEST_MAX_QUEUED` 500).

**Result: the API no longer crashes on reads with a 10,000-turbine fleet, and one worker now takes about 940 readings/s instead of about 320, at the cost of higher latency below saturation. The queue limit barely fired, and it doesn't protect a worker that is out of CPU.**

### Ingestion, before and after

All from inside the Docker network, 10,000-turbine fleet, 30 s. The baseline's 67/s row was from the host, so that row's latency isn't directly comparable.

| Rate | Accepted before | Accepted after | Other results after | p50 before → after | p99 before → after | Report |
|---|---|---|---|---|---|---|
| 67/s | 2,000 of 2,000 | 2,010 of 2,010 | none | 4 → 4 ms | 7.9 → 32.1 ms | [report](../load/results/after-2026-11-04-ingest-67rps.json) |
| 333/s | 10,000 of 10,000 | 9,990 of 9,990 | none | 3 → 15 ms | 53 → 176 ms | [report](../load/results/after-2026-11-04-ingest-333rps.json) |
| 500/s | 9,482 of 15,000 | 15,000 of 15,000 | none | 2,019 → 28 ms | 2,101 → 247 ms | [report](../load/results/after-2026-11-04-ingest-500rps.json) |
| 1,000/s | 6,778 of 30,000 | 28,231 of 30,000 | 1,769 `EADDRNOTAVAIL` (client) | 2,618 → 55 ms | 5,827 → 392 ms | [report](../load/results/after-2026-11-04-ingest-1000rps.json) |
| 2,000/s (new) | not run | 26,568 of 60,000 | 38 HTTP 503, 3,507 socket timeouts, 29,887 `EADDRNOTAVAIL` (client) | 508 ms | 7,117 ms | [report](../load/results/after-2026-11-04-ingest-2000rps.json) |

- **Throughput:** no HTTP 500s at any rate. At 1,000/s the worker accepted everything that reached it, about 940/s, with CPU at 94-100% of its 1 CPU limit, so this is close to its ceiling.
- **The 1,000/s shortfall is the load generator:** `EADDRNOTAVAIL` means the Artillery container ran out of local ports. Accepted connections stopped at 28,231, which is the size of Linux's default ephemeral port range (32768-60999). Those requests never reached the worker. The same limit dominates the 2,000/s run, so that run doesn't measure 2,000/s offered to the worker.
- **Latency cost:** below saturation, latency rose: at 333/s, p50 went from 3 to 15 ms and p99 from 53 to 176 ms. Worker CPU at 333/s was about the same, 65-78%.
- **The queue limit:** at 2,000/s it fired only 38 times, and those were the only 503s, while 3,507 requests timed out on the client with p99 at 7 s. With the CPU at its limit, requests wait in Node before they reach the queue, so the limit can't reject them quickly. It bounds the queue's memory; it isn't general overload protection. The worker didn't crash or restart.
- **Stored rows:** a row count across the runs: 2,010, 9,990, 15,000 and 28,231 rows added, equal to the accepted count in each. At 2,000/s, 28,207 rows were added against 26,568 accepted: the 1,639 extra are probably client timeouts that finished on the server. Pub/Sub would redeliver those and they'd be skipped as duplicates (idempotent on turbine and timestamp), though this test doesn't cover redelivery.

### Reads, before and after

30 arrivals/s for 60 s, 3 requests each, from the host.

| Fleet | Before | After | p99 after | API memory after | Report |
|---|---|---|---|---|---|
| 10,000, every turbine reporting (`/api/farms` 3.6 MB) | **crashed**, 6 of 1,806 OK | 5,400 of 5,400 OK | 206.5 ms | peak about 144 MB, CPU peak 84% | [report](../load/results/after-2026-11-04-reads-10000-turbines-full-30rps.json) |
| 10,000, partly reporting (`/api/farms` 2.1 MB) | not run | 5,400 of 5,400 OK | 133 ms | peak about 118 MB | [report](../load/results/after-2026-11-04-reads-10000-turbines-partial-30rps.json) |
| 200 (`/api/farms` 22 KB) | 5,400 of 5,400 OK, p99 16.9 ms | 5,400 of 5,400 OK | 12.1 ms | peak about 97 MB | [report](../load/results/after-2026-11-04-reads-200-turbines-30rps.json) |

A single `/api/farms` at 10,000 turbines took 554 ms on a cache miss (a cold start) and 23 ms on a hit. Only the first row matches the baseline's crash scenario; the partly reporting run came first, and the full run was added so the payload sizes matched. The full run's stack held about 10,500 readings against the baseline's about 48,000; `/api/farms` reads only each turbine's latest reading, so that shouldn't matter much, but it wasn't tested.

### The connection resets

They came back while filling that stack: on the second of two consecutive 10,000-request runs from the host, 534 requests succeeded and then the next 9,466 got `ECONNRESET`. Together with the baseline's run (2,000 then 9,120 before the resets), they started after about 10,500-11,100 new connections from the host in a short window. No run inside the Docker network has shown them, including ones with over 28,000 connections. That points at Docker Desktop's host port forwarding rather than the worker, but it's still not proven.

### Still not covered

Pub/Sub delivery and retries, SSE, more than one instance, and real Cloud Run and Cloud SQL. In production, `ingestion_concurrency` (100) is below `INGEST_MAX_QUEUED` (500), so Cloud Run's request limit applies before the worker's queue limit can.

## Baseline: 2026-11-04

Same throwaway stack and machine as the smoke run, except that the main compose stack and its demo feed were also running and sharing the CPU. One instance of each service, limited to 1 CPU and 512 MB, `DB_POOL_MAX` 5. Bursts of 30 s; the 5-minute steady rates were not run.

**Result: ingestion saturates between 333 and 500 readings/s per worker, and the API runs out of memory on reads with a 10,000-turbine fleet.** The code as tested is the revision before the farms cache and ingestion batching; see the [rerun](#after-the-fixes-2026-11-04).

### Ingestion

| Rate | Fleet | From | Sent | 204 | Other results | p50 | p95 | p99 | Report |
|---|---|---|---|---|---|---|---|---|---|
| 5/s | 200 | host | 150 | 150 | none | 8.9 ms | 16.9 ms | 71.5 ms | [report](../load/results/baseline-2026-11-04-ingest-5rps.json) |
| 67/s | 2,000 | host | 2,000 | 2,000 | none | 4 ms | 6 ms | 7.9 ms | [report](../load/results/baseline-2026-11-04-ingest-67rps.json) |
| 333/s, run 1 | 10,000 | host | 10,000 | 9,120 | 880 `ECONNRESET` | 4 ms | 22.9 ms | 40.9 ms | [report](../load/results/baseline-2026-11-04-ingest-333rps-run1.json) |
| 333/s, run 2 | 10,000 | host | 10,000 | 10,000 | none | 4 ms | 10.9 ms | 30.3 ms | [report](../load/results/baseline-2026-11-04-ingest-333rps-run2-host.json) |
| 333/s, run 3 | 10,000 | Docker network | 10,000 | 10,000 | none | 3 ms | 6 ms | 53 ms | [report](../load/results/baseline-2026-11-04-ingest-333rps-run3-network.json) |
| 500/s | 10,000 | Docker network | 15,000 | 9,482 | 5,518 HTTP 500 | 2,019 ms | 2,060 ms | 2,101 ms | [report](../load/results/baseline-2026-11-04-ingest-500rps.json) |
| 1,000/s | 10,000 | Docker network | 30,000 | 6,778 | 19,551 HTTP 500, 3,350 socket timeouts, 321 `EADDRNOTAVAIL` | 2,618 ms | 3,678 ms | 5,827 ms | [report](../load/results/baseline-2026-11-04-ingest-1000rps.json) |

- **Saturation:** the 500s are Prisma's `Unable to start a transaction in the given time`, and the p50 of about 2 s matches its default 2 s `maxWait`. Each reading was its own transaction.
- **Past the limit, throughput falls:** about 316/s accepted at 500/s offered, about 226/s at 1,000/s. The last CPU samples for the worker were 97% at 500/s and 99% at 1,000/s.
- **Unexplained resets:** in 333/s run 1, the last 880 requests all got `ECONNRESET` within about 3 s. The worker logged no error, didn't restart and wasn't near its CPU limit, and latency was flat until then. Two repeats didn't reproduce it. The connection path from the host is suspected, unproven; see [the resets after the fixes](#the-connection-resets).
- **Stored rows:** `load:check` matched at [5/s](../load/results/baseline-2026-11-04-check-5rps.json) and [67/s](../load/results/baseline-2026-11-04-check-67rps.json), and at [333/s run 1](../load/results/baseline-2026-11-04-check-333rps-run1.json) stored equalled the 9,120 acknowledged (its `match: false` compares against the 10,000 sent). Across the whole 10,000-turbine stack, 48,415 rows were stored against 47,530 acknowledged. The 885 extra are probably requests that timed out on the client but finished on the server; not confirmed.

### Reads

30 arrivals/s for 60 s, 3 requests each, with a fresh stack for the 200-turbine run.

| Fleet | Requests | 200 | Errors | p99 | API memory | `/api/farms` alone | Report |
|---|---|---|---|---|---|---|---|
| 200 | 5,400 | 5,400 | none | 16.9 ms | about 90 MB | 22 KB, 40 ms | [report](../load/results/baseline-2026-11-04-reads-200-turbines-30rps.json) |
| 10,000 | 1,806 | 6 | 1,341 refused, 249 reset, 210 timed out | not meaningful | **crashed** | 3.6 MB, 430 ms | [report](../load/results/baseline-2026-11-04-reads-10000-turbines-30rps.json) |

**The crash:** `FATAL ERROR: Reached heap limit Allocation failed` at about 250 MB of heap, exit 139. Docker's out-of-memory flag was false: this is the Node heap limit, below the container's 512 MB. The likely cause is `/api/farms`: at 430 ms per request on 1 CPU it can't keep up, so responses queue in memory. This was inferred from sizes and timings, not profiled. That stack also held about 48,000 readings, so fleet size isn't the only difference between the two rows.

CPU and memory samples: [67/s](../load/results/baseline-2026-11-04-stats-2000.txt), [333/s](../load/results/baseline-2026-11-04-stats-10000.txt), [500/s](../load/results/baseline-2026-11-04-stats-r500.txt), [1,000/s](../load/results/baseline-2026-11-04-stats-r1000.txt), [reads, 200 turbines](../load/results/baseline-2026-11-04-stats-reads200.txt).

## Smoke run: 2026-11-03

**This run proves the harness works. It says nothing about capacity.** It sent a low, fixed rate to one instance of each service on a laptop. No limit was looked for or found.

### What was run

Run on 2026-11-03 against a throwaway compose stack (`load/docker-compose.yml`): Postgres, Redis, `migrate`, `ingestion` and `api`.

| Scenario | File | Load | Target |
|---|---|---|---|
| Ingestion | `load/ingest.yml` | 5 arrivals per second for 30 s | `POST /pubsub/telemetry`, one Pub/Sub push envelope per arrival, 200-turbine fleet |
| Reads | `load/reads.yml` | 2 arrivals per second for 15 s, 3 requests each, after one sign-in as `viewer@nextera.local` | `GET /api/farms`, `/api/turbines/TURB001/telemetry`, `/api/farms/FARM01/telemetry/daily` |

**Machine:** Apple M1 Pro (10 CPUs, 16 GB), macOS 15.7.7, Node 24.15.0, Artillery 2.0.34. Docker Desktop 29.8.2 (linux/arm64 VM with 10 CPUs and 7.7 GB). `api` and `ingestion` were limited to 1 CPU and 512 MB, as in `docker-compose.yml`. Postgres 18.4 and Redis 8.10.2. Artillery ran on the same machine as the stack.

### Results

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

### Limits of these numbers

- **Time to store** is `created_at - received_at`. `created_at` defaults to `now()`, the start of the insert's transaction, so the figure leaves out the insert and the commit. It also compares two clocks: `received_at` is the publish time from the host running Artillery, and `created_at` comes from the Postgres container.
- **Small sample:** with 90 to 150 requests, p99 and max rest on one or two requests.
- **Low rate:** at 5 per second, nothing was near saturation, so these response times don't predict behaviour under load.
- **Local-database guard:** `load:setup` and `load:check` accept only a `LOAD_DATABASE_URL` on localhost, and also reject a remote `?host=` or `?hostaddr=`. They can't detect a TCP proxy listening on localhost, such as the Cloud SQL Auth Proxy, so don't run them with one pointed at a real database.

## Planned rates

Steady is the fleet size ÷ 300 s, since each turbine reports every 5 minutes. Burst is a proposed worst case: the whole fleet reporting within 30 s.

| Turbines | Steady | Burst | Status |
|---|---|---|---|
| 200 | 0.67 per second | 6.7 per second | not run at these rates; the 5 per second smoke run is close to the burst |
| 2,000 | 6.7 per second | 67 per second | burst passed; steady not run |
| 10,000 | 33 per second | 333 per second | burst passed from inside the Docker network; resets from the host (see above); steady not run |

A burst run lasts 30 s, not a full 300 s reporting cycle.

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
