# Cloud Monitoring: email notification channels (var.alert_emails), HTTPS uptime checks on the public
# services, alert policies for the failure modes that otherwise go unnoticed (dead letters, an
# ingestion backlog, 5xx errors, failing health checks, failed Cloud Run Job executions, Cloud SQL and
# Redis pressure) and an optional
# monthly billing budget (var.billing_account). Every policy exists even with no email addresses: it
# then only opens incidents in the console (Monitoring -> Alerting).
# Ingestion is IAM-only, so it has no uptime check; the 5xx and backlog policies cover it.

locals {
  # Thresholds (tune here; deliberately not variables, to keep the variable list short).
  dead_letter_threshold        = 0    # undelivered messages in telemetry-dead-letter
  backlog_max_age_seconds      = 900  # oldest unacked message on telemetry-ingestion
  error_ratio_threshold        = 0.05 # 5xx / all requests per Cloud Run service
  uptime_failed_regions        = 1    # alert when MORE than this many checker regions fail (i.e. >= 2)
  sql_cpu_threshold            = 0.8  # Cloud SQL CPU utilisation (0-1)
  sql_connection_budget_ratio  = 0.8  # share of the app's connection budget in use
  redis_memory_ratio_threshold = 0.8  # Memorystore used / max memory (0-1)

  # The apps' connection budget: every API and worker instance opens at most db_pool_max connections.
  sql_connection_budget  = (var.api_max_instances + var.ingestion_max_instances) * var.db_pool_max
  sql_backends_threshold = floor(local.sql_connection_budget * local.sql_connection_budget_ratio)

  alert_channels = [for channel in google_monitoring_notification_channel.email : channel.name]

  # Filter values for the policies below.
  cloud_run_service_names = join(", ", [
    for service in [google_cloud_run_v2_service.api, google_cloud_run_v2_service.ingestion, google_cloud_run_v2_service.web] :
    "\"${service.name}\""
  ])
  sql_database_id = "${var.project_id}:${google_sql_database_instance.main.name}" # Cloud SQL's database_id label

  # The scheduled Cloud Run Jobs that exist (farm-rollup.tf, weather-sync.tf, demo-feed.tf).
  scheduled_jobs = merge(
    var.farm_rollup_enabled ? { farm_rollup = google_cloud_run_v2_job.farm_rollup[0].name } : {},
    var.weather_sync_enabled ? { weather_sync = google_cloud_run_v2_job.weather_sync[0].name } : {},
    var.demo_feed_enabled ? { demo_feed = google_cloud_run_v2_job.demo_feed[0].name } : {},
  )
  cloud_run_job_names = join(", ", [for name in values(local.scheduled_jobs) : "\"${name}\""])

  uptime_checks = {
    api = {
      host = trimprefix(google_cloud_run_v2_service.api.uri, "https://")
      path = "/api/health/ready" # checks the database and Redis
    }
    web = {
      host = trimprefix(google_cloud_run_v2_service.web.uri, "https://")
      path = "/"
    }
  }
}

# --- Notification channels ------------------------------------------------------
# Email channels need no verification; send a test notification from the console after apply.

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_emails)

  display_name = "nextera alerts: ${each.value}"
  type         = "email"
  labels = {
    email_address = each.value
  }

  depends_on = [google_project_service.this]
}

# --- Uptime checks ----------------------------------------------------------------
# From every checker region, every 60 s, against the run.app URLs (a custom domain's certificate may
# still be provisioning). The API's check answers 503 when the database or Redis is unreachable.

resource "google_monitoring_uptime_check_config" "service" {
  for_each = local.uptime_checks

  display_name = "nextera-${each.key} ${each.value.path}"
  period       = "60s"
  timeout      = "10s"

  http_check {
    path         = each.value.path
    port         = 443
    use_ssl      = true
    validate_ssl = true
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = each.value.host
    }
  }

  depends_on = [google_project_service.this]
}

# --- Alert policies -----------------------------------------------------------------

resource "google_monitoring_alert_policy" "dead_letters" {
  display_name          = "nextera: telemetry in the dead-letter topic"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "telemetry-dead-letter has undelivered messages"

    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND resource.label.subscription_id = \"${google_pubsub_subscription.telemetry_dead_letter.name}\" AND metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.dead_letter_threshold
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Telemetry messages failed ${var.pubsub_max_delivery_attempts} push deliveries to nextera-ingestion and were moved to the dead-letter topic. They are kept for 7 days.

      1. Look at them: `gcloud pubsub subscriptions pull ${google_pubsub_subscription.telemetry_dead_letter.name} --limit 10` (without `--auto-ack` they stay in the subscription).
      2. Find the cause in `gcloud run services logs read nextera-ingestion`: a 400 is an invalid payload, an unknown turbine or a farm mismatch (fix the sender or seed the turbine); a 5xx is a worker, Cloud SQL or Redis problem.
      3. After the fix, republish the messages to the `telemetry` topic. Replay is safe: ingestion is idempotent on (turbine_id, timestamp), so readings already stored are skipped. Then ack them here.

      The incident closes when the subscription is empty.
    EOT
  }

  depends_on = [google_project_service.this]
}

resource "google_monitoring_alert_policy" "ingestion_backlog" {
  display_name          = "nextera: ingestion backlog"
  combiner              = "OR"
  severity              = "WARNING"
  notification_channels = local.alert_channels

  conditions {
    display_name = "telemetry-ingestion oldest unacked message > ${local.backlog_max_age_seconds} s"

    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND resource.label.subscription_id = \"${google_pubsub_subscription.telemetry_ingestion.name}\" AND metric.type = \"pubsub.googleapis.com/subscription/oldest_unacked_message_age\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.backlog_max_age_seconds
      duration        = "60s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Pub/Sub has not been able to deliver telemetry to nextera-ingestion for more than ${local.backlog_max_age_seconds / 60} minutes, so the dashboards fall behind (turbines show "No data in 15/30/60 min").

      - Check the worker: `gcloud run services logs read nextera-ingestion` (5xx, timeouts, Cloud SQL or Redis errors) and its revision status.
      - At max instances (ingestion_max_instances = ${var.ingestion_max_instances}) under a burst, the backlog drains on its own; raise the cap only if Cloud SQL has connections to spare.
      - Messages that keep failing move to the dead-letter topic after ${var.pubsub_max_delivery_attempts} attempts; nothing is lost while they wait.
    EOT
  }

  depends_on = [google_project_service.this]
}

resource "google_monitoring_alert_policy" "cloud_run_errors" {
  display_name          = "nextera: Cloud Run 5xx ratio"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "5xx > ${local.error_ratio_threshold * 100}% of requests, per service"

    condition_threshold {
      filter             = "resource.type = \"cloud_run_revision\" AND resource.label.service_name = one_of(${local.cloud_run_service_names}) AND metric.type = \"run.googleapis.com/request_count\" AND metric.label.response_code_class = \"5xx\""
      denominator_filter = "resource.type = \"cloud_run_revision\" AND resource.label.service_name = one_of(${local.cloud_run_service_names}) AND metric.type = \"run.googleapis.com/request_count\""
      comparison         = "COMPARISON_GT"
      threshold_value    = local.error_ratio_threshold
      duration           = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }

      denominator_aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      More than ${local.error_ratio_threshold * 100}% of the requests to one Cloud Run service (see the service_name label) answered 5xx for 5 minutes.

      1. Logs: `gcloud run services logs read <service>` (nextera-api, nextera-ingestion or nextera-web).
      2. If it started with a deploy, roll back: `gcloud run services update-traffic <service> --to-revisions <previous revision>=100`.
      3. nextera-api / nextera-ingestion: check Cloud SQL (connections, CPU) and Memorystore; the readiness check is /api/health/ready.
      4. nextera-ingestion 5xx are retried by Pub/Sub and end in the dead-letter topic after ${var.pubsub_max_delivery_attempts} attempts (replay is safe).
    EOT
  }

  depends_on = [google_project_service.this]
}

# One policy per uptime check, so the incident names the failing service.
resource "google_monitoring_alert_policy" "uptime" {
  for_each = google_monitoring_uptime_check_config.service

  display_name          = "nextera: ${each.value.display_name} is down"
  combiner              = "OR"
  severity              = "CRITICAL"
  notification_channels = local.alert_channels

  conditions {
    display_name = "Uptime check fails from 2+ regions"

    condition_threshold {
      filter          = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id = \"${each.value.uptime_check_id}\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.uptime_failed_regions
      duration        = "60s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id", "resource.label.host"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      https://${local.uptime_checks[each.key].host}${local.uptime_checks[each.key].path} fails from 2 or more checker regions.

      - nextera-api: /api/health/ready answers 503 when Cloud SQL or Memorystore is unreachable. Check `gcloud run services logs read nextera-api`, the Cloud SQL instance and Redis.
      - nextera-web: nginx refuses to start on a bad API_BASE_URL (Cloud Run then keeps the previous revision). Check `gcloud run services logs read nextera-web`.
      - After a bad deploy, roll back: `gcloud run services update-traffic <service> --to-revisions <previous revision>=100`.
    EOT
  }

  depends_on = [google_project_service.this]
}

# One policy for every scheduled job (none when all are off); the job_name label names the job.
# completed_execution_count is a DELTA counter written when an execution ends (after its task
# retries), with its outcome in the result label.
resource "google_monitoring_alert_policy" "job_failures" {
  count = length(local.scheduled_jobs) > 0 ? 1 : 0

  display_name          = "nextera: Cloud Run Job execution failed"
  combiner              = "OR"
  severity              = "ERROR"
  notification_channels = local.alert_channels

  conditions {
    display_name = "A failed execution, per job"

    condition_threshold {
      filter          = "resource.type = \"cloud_run_job\" AND resource.label.job_name = one_of(${local.cloud_run_job_names}) AND metric.type = \"run.googleapis.com/job/completed_execution_count\" AND metric.label.result = \"failed\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.job_name"]
      }
    }
  }

  alert_strategy {
    auto_close = "1800s" # a failure is a single point: close once no failure has come for 30 min
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      An execution of a scheduled Cloud Run Job (see the job_name label) failed after its retries.

      1. Logs: `gcloud run jobs executions list --job <job> --region ${var.region}`, then `gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="<job>"' --limit 50`.
      2. On a fresh project the job may still run Terraform's placeholder image: the next deploy (deploy.yml) sets the ingestion image.
      3. Per job:
         - **nextera-farm-rollup** (every 15 min): the farm History tab stops updating. Usually Cloud SQL (connections, the database-url secret) or a migration that hasn't run. The next successful run catches up from its watermark; rebuild with `--full` if needed.
         - **nextera-weather-sync** (daily): Open-Meteo errors or quota (open_meteo_api_key_enabled), or Cloud SQL. Backfill missing days with `--from … --to …`.
         - **nextera-demo-feed** (every 5 min): a publish to the telemetry topic failed; a missed tick is only a gap.
      4. Run it by hand once fixed: `gcloud run jobs execute <job> --region ${var.region}`.
    EOT
  }

  depends_on = [google_project_service.this]
}

resource "google_monitoring_alert_policy" "cloud_sql" {
  display_name          = "nextera: Cloud SQL pressure"
  combiner              = "OR"
  severity              = "WARNING"
  notification_channels = local.alert_channels

  conditions {
    display_name = "CPU > ${local.sql_cpu_threshold * 100}% for 10 min"

    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.label.database_id = \"${local.sql_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/cpu/utilization\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.sql_cpu_threshold
      duration        = "600s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  conditions {
    display_name = "Connections > ${local.sql_backends_threshold} (${local.sql_connection_budget_ratio * 100}% of the ${local.sql_connection_budget}-connection budget)"

    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.label.database_id = \"${local.sql_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/postgresql/num_backends\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.sql_backends_threshold
      duration        = "300s"

      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_MEAN"
        cross_series_reducer = "REDUCE_SUM" # num_backends is per database
        group_by_fields      = ["resource.label.database_id"]
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Cloud SQL ${google_sql_database_instance.main.name} (${var.db_tier}) is close to its limits.

      - **CPU:** look for slow queries in Query Insights (wide /api/reports or /api/alerts ranges, a full telemetry scan). If the load is legitimate, raise db_tier.
      - **Connections:** the apps may open (api_max_instances ${var.api_max_instances} + ingestion_max_instances ${var.ingestion_max_instances}) x db_pool_max ${var.db_pool_max} = ${local.sql_connection_budget}. Running out shows up as Prisma pool timeouts and 5xx. Either lower the instance caps or db_pool_max, or raise db_tier (max_connections) and the budget together. Migrations, the Auth Proxy and the MCP server count too.
    EOT
  }

  depends_on = [google_project_service.this]
}

resource "google_monitoring_alert_policy" "redis_memory" {
  display_name          = "nextera: Memorystore memory"
  combiner              = "OR"
  severity              = "WARNING"
  notification_channels = local.alert_channels

  conditions {
    display_name = "Redis memory usage > ${local.redis_memory_ratio_threshold * 100}%"

    condition_threshold {
      filter          = "resource.type = \"redis_instance\" AND resource.label.instance_id = \"${google_redis_instance.events.id}\" AND metric.type = \"redis.googleapis.com/stats/memory/usage_ratio\""
      comparison      = "COMPARISON_GT"
      threshold_value = local.redis_memory_ratio_threshold
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
    }
  }

  documentation {
    mime_type = "text/markdown"
    content   = <<-EOT
      Memorystore ${google_redis_instance.events.name} (${google_redis_instance.events.memory_size_gb} GB) is over ${local.redis_memory_ratio_threshold * 100}% full. It holds the SSE event stream (Last-Event-ID replay) and the pub/sub fan-out; when full, writes fail and live updates stop.

      - Check that the event stream is still trimmed (EventStore in @nextera/shared) and look for unexpected keys (`redis-cli --bigkeys` from a VM in the VPC).
      - If the fleet has simply grown, raise memory_size_gb in redis.tf.
    EOT
  }

  depends_on = [google_project_service.this]
}

# --- Billing budget (optional) ---------------------------------------------------------
# Only with var.billing_account. Whoever applies needs roles/billing.costsManager on the billing
# account. The Billing Budgets API needs a quota project with user credentials, hence the
# google.billing_budget provider (versions.tf). A budget takes at most 5 notification channels.

resource "google_billing_budget" "monthly" {
  count    = var.billing_account == "" ? 0 : 1
  provider = google.billing_budget

  billing_account = var.billing_account
  display_name    = "nextera monthly (${var.project_id})"

  budget_filter {
    projects        = ["projects/${data.google_project.this.number}"]
    calendar_period = "MONTH"
  }

  amount {
    specified_amount {
      units = tostring(var.monthly_budget) # in the billing account's currency
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = slice(local.alert_channels, 0, min(5, length(local.alert_channels)))
  }

  depends_on = [google_project_service.this]
}
