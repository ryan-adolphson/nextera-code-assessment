# Design decisions

Why the system is built this way, and what each choice gives up. For what it does and how to run it, see the [README](../README.md).

## Assumptions

This is a proof of concept. The assumptions below were made to support a reasonable load and scope. A production application would need further detail on requirements, expected volumes and service levels.

- **Data:** each turbine reports power, wind speed, rotor speed, blade pitch and gearbox temperature every 5 minutes. Readings can be late, missing or wrong, and some come from turbines we don't know about.
- **Users:** the primary users are assumed to be farm owners, with NextEra also managing the application for a small subset of farms.
- **Roles:** the viewer, owner and admin roles are placeholders, included to show how a user hierarchy would look and work.
- **Timeliness:** live means within seconds, not milliseconds.
- **Business impact:** the main cost is assumed to be a turbine that is down or underperforming without anyone noticing, since it loses generation until the problem is found. Missing or stale data is therefore shown, not hidden. A production application would need this quantified.
- **Scale:** the demo runs 200 turbines, which is assumed to be a reasonable load for a proof of concept. The architecture leaves room to grow, but its limit hasn't been measured (see [Scaling](#scaling)). A production application would need target fleet sizes and growth estimates.

## Key decisions

These decisions were made to keep the proof of concept reasonably simple, with a clear understanding of the limitations of an application that isn't production-ready. Where a choice would need to change at larger scale, the [Scaling](#scaling) section covers it.

### Pub/Sub push with a dead-letter queue, not direct calls from turbines
- **Why:** turbines and the worker are decoupled. Pub/Sub absorbs bursts and retries failures with backoff. After 10 failed deliveries (about 40 minutes of backoff retries), a message moves to a dead-letter topic instead of being lost.
- **Cost:** delivery is at-least-once, so ingestion must be idempotent. It is: readings are unique on `(turbine_id, timestamp)`, and duplicates are skipped.
- **Business effect:** a worker outage delays data but doesn't lose it, within the 7-day retention.

### Postgres and Redis, not a time-series database
- **Why:** the data is relational (farms, turbines, rules, users, alert links), and the alert rules and readings need to be written in one transaction. One well-understood database is less to run and to explain.
- **Cost:** Postgres needs more care at high row counts: indexes, rollups and eventually partitioning.
- **Redis** handles the live side only: fan-out to every API instance, plus a capped stream of 1,000 events so a reconnecting client can catch up. Postgres stays the source of truth, and losing Redis loses no data.

### Server-Sent Events, not WebSockets or polling
- **Why:** updates only flow from server to browser, and SSE gives that over plain HTTP with built-in reconnect and `Last-Event-ID` resume.
- **Cost:** `EventSource` can't send headers, so the token goes in the URL for that one route and appears in request logs. See [Accepted shortcuts](#accepted-shortcuts).
- **Business effect:** operators see new readings without reloading, without the load of every browser polling.

### Hold readings from unknown turbines, don't reject them
- **Why:** rejecting them sends real data to the dead-letter queue, where no operator sees it. A new turbine or a mistaken farm setting is an operational question. So these readings are held for 7 days, and an owner assigns, keeps, moves or blocks the turbine, and the held readings are imported with alerts evaluated.
- **Cost:** extra tables and a workflow. A flood of junk IDs is capped at 500 pending entries; beyond that, new pairs return to the dead-letter path.
- **Business effect:** a commissioning mistake doesn't lose a week of production data.

### Scheduled rollup for farm history, not calculating on ingest
- **Why:** a farm's total for a timestamp isn't known until its turbines have reported. Recalculating on ingest would put extra work on every reading and have a farm's turbines contending for the same row. A job every 15 minutes recalculates only what changed, including late readings, backfills and turbine moves.
- **Cost:** the History tab can be up to 15 minutes behind, and the page says so. There's one more job to monitor, so failed runs raise an alert.
- **Storage:** 30-minute buckets, grouped into days when read. That lets one table answer for UTC or local days, including days when the clocks change.
- **Business effect:** six months of history stays fast without slowing the path that matters most.

### Anomaly checks stored hourly, not calculated when read
- **Changed for scale:** they were first calculated on read, but the 7-day query would scan about 2 billion rows at a million turbines. An hourly job now stores episodes, so they can be up to an hour late.
- **Why:** static thresholds miss faults that depend on context. Two checks cover that: low power in strong wind, and a sensor stuck on one value for at least an hour while the turbine's power keeps changing. Each low-power episode gets an estimated lost output, so faults can be ranked by cost.
- **Cost:** the 7-day query takes about 2 seconds on 400,000 readings, measured on a laptop. The limits were tuned on generated data.
- **Noise was the main risk:** the first version of the stuck-sensor rule produced about 15,000 false alarms in 7 days on demo data. Requiring an hour and changing power brought that to zero on that data.
- **Business effect:** operators see which faults cost the most generation, not just which values crossed a line.

### Weather per farm, not per turbine
- **Why:** Open-Meteo's model grid is 9–25 km, and a farm's turbines sit within a few km, so per-turbine calls would mostly return duplicates. It's stored every 30 minutes from 15-minute model data.
- **Cost:** it's model data at 80 m, not a measurement at each turbine.
- **Business effect:** it helps separate "there was no wind" from "the turbine has a problem".

### Cloud Run, not Kubernetes or VMs
- **Why:** three stateless containers and scheduled jobs don't need a cluster. Scaling and rollouts are handled for me, and Terraform defines everything.
- **Cost:** per-instance limits matter. Every instance holds database connections, so instance counts and pool sizes have to stay within what Postgres allows. SSE streams also reconnect when requests hit Cloud Run's time limit.

## Scaling

The app is built for up to 1,000,000 turbines, about 10,000 farms and 1,000 concurrent viewers. **That target is not proven.** [Load tests](load-test.md) measured one instance on a laptop before this design: about 940 readings/s per worker and no API crash at 10,000 turbines. Those numbers predate the `turbine_latest` upsert, so the worker figure may now be lower. Single queries were timed against a seeded million (mostly under 100 ms at p95), but with no concurrent load. Million-turbine load, real Cloud SQL and Pub/Sub retries remain untested. Sizing estimates are in [scaling-gcp.md](scaling-gcp.md).

| Turbines | Readings per second, on average | Rows per day |
|---|---|---|
| 200 | 0.67 | about 58,000 |
| 10,000 | 33 | about 2.9 million |
| 1,000,000 | 3,333 | about 288 million |

What changed to reach it:

1. **Bursts of per-reading transactions:** group commit in the worker, with a queue limit that answers 503.
2. **The browser held the whole fleet:** server keyset paging and per-farm summaries, so a page holds at most 100 turbines.
3. **Live events to every browser:** only the visible turbines' readings go to each client (per-turbine Redis channels), and tiles refresh once a minute.
4. **Table size:** daily partitions with 31 days of raw readings, and rollups kept for 190 days.
5. **Reads over raw data:** `turbine_latest`, farm summaries and stored anomaly episodes replace scans.
6. **Database size:** the default `db-g1-small` tier stays a demo choice, and is the first thing to raise.

## Accepted shortcuts

These are proof-of-concept choices I'd change before production.

| Shortcut | Risk | Fix |
|---|---|---|
| Token kept in localStorage | Readable by a cross-site scripting attack | Short-lived tokens with an httpOnly refresh cookie |
| SSE token in the URL | Appears in request logs | A short-lived, single-use stream ticket |
| Login limit is per IP and email, in Redis, and fails open | No limit during a Redis outage; 20 wrong attempts lock an email out for up to 15 minutes; IPv6 clients can rotate addresses past the IP limits | Edge rate limiting too, group IPv6 by /64, alert on limiter warnings |
| Tokens can't be revoked individually (24 h life) | A stolen token works until it expires, unless the user is deactivated | Shorter life and refresh tokens |
| Free Open-Meteo API | Non-commercial use only | Paid key; the app already supports `OPEN_METEO_API_KEY` |
| Demo accounts are listed on the login page | Reveals which accounts exist | Remove it, or enable it only in demo environments |
| Anomaly limits are tuned on demo data | The 50 kW and 1-hour stuck-sensor limits come from generated data, so real turbines may need different values | Tune them against real readings, per turbine model if needed |
| Lost output is a rough estimate | It compares against the fleet's median at the same wind speed, not a power curve for each turbine | Use manufacturer power curves |

## With another week

1. **Run the load test** at the planned rates against a deployed environment, and fix the first real bottleneck.
2. **Tune anomaly detection against real data,** and store the results if the roughly 2-second query on each fleet page load becomes a problem.
3. **Keyboard focus:** make focus visible on Material controls, and keep it on the tab after switching tabs (a known bug, recorded as an expected-failure test).

## How I used AI

I used Claude Code with specialist agents for each area (web, Material UI, backend, infrastructure, CI, front-end testing), with project rules in the repo. I made the product and design decisions, and treated agent output as work to verify.

- **I set the direction and changed it when it was wrong.** For example, I had weather built into the turbine page, then moved it to the farm page so users can quickly see a weather overview. Rollups on ingest vs on a schedule was my call, after looking at the tradeoffs.
- **Testing caught real mistakes.** Browser tests found that Refresh was being answered from the browser's HTTP cache, and that rows jumped during live updates when the table was scrolled. A flaky test first looked like a rendering stall, but the trace showed the clock moving backward during a map animation.
- **Reference material was checked against the code.** The Angular Material guidance was verified against the installed package, where it showed the docs and the code disagree on one option name.
- **Its costs got caught too.** Adding Artillery to the root project pulled in a browser download and changed a production dependency, so it moved to its own project.
