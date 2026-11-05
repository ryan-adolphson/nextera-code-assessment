# Sizing for a million turbines on GCP

**Documented only, and unproven.** Every number here is an estimate from the local load runs ([load-test.md](load-test.md)) and the table sizes, not a measurement on GCP. The Terraform defaults stay demo-sized (`ingestion_max_instances` 5, `db_tier` `db-g1-small`, small disk), so nothing here changes your bill until you set it in your own `terraform.tfvars` (never committed). Re-measure with the load test after each step.

At 1,000,000 turbines reporting every 5 minutes the system takes about 3,300 readings/s sustained. One ingestion worker took about 940 readings/s on a laptop at 1 CPU, so the worker count below has some margin.

| Variable | Demo default | Million-turbine estimate | Why |
|---|---|---|---|
| `ingestion_max_instances` | 5 | about 20 | 3,300 readings/s over about 940/s per instance is 4 instances at the limit; 20 leaves room for bursts and late deliveries |
| `db_tier` | `db-g1-small` | a large custom/dedicated-core tier (for example `db-custom-16-65536` or bigger) | write rate, the partitioned indexes and the rollup jobs' scans; also more `max_connections` |
| Disk (set in `database.tf`; not a variable today) | small | about 3 TB, with auto-resize | 31 days of readings (default `telemetry_retention_days`) at about 290 million rows a day, plus indexes and WAL |
| `telemetry_retention_days` | 31 | 31 or less | dropping whole-day partitions is what keeps the disk bounded |
| Connection pooling | none (each instance holds `db_pool_max` connections) | a pooler (PgBouncer, transaction mode, or Managed Connection Pooling on Cloud SQL Enterprise Plus) in front of Postgres | 20 instances x `db_pool_max` plus the API and 5 job pools quickly exceed `max_connections`; the pooler decouples the two |

## Connections

`sql_connection_budget` (monitoring.tf) is `(api_max_instances + ingestion_max_instances) x db_pool_max + 2 x enabled scheduled jobs`: each job opens a pool of 2 and runs one execution at a time (`parallelism = 1`). With the defaults that is 10 x 4 + 4 jobs x 2 = 48 (farm rollup, partition maintenance, live summary, anomaly rollup). A deploy-time `gcloud run jobs execute` can overlap a scheduled run, so keep headroom (the alert fires at 80%). At 20 ingestion instances the budget is well above what a small tier allows, hence the pooler.

## Scheduled jobs

`partition-maintenance` must keep running: the migration created partitions for today through +3 days, and without the daily job readings fall into the DEFAULT partition. `live-summary` runs every minute (about 43,200 executions a month; see the cost note in `live-summary.tf`, roughly 5-25 USD a month, about 10 USD at 10 s a run), and `anomaly-rollup` runs hourly (about 70 s the first time at 1M turbines, seconds later).
