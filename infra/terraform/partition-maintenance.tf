# Telemetry partition maintenance (var.partition_maintenance_enabled, on by default): Cloud
# Scheduler runs the Cloud Run Job nextera-partition-maintenance once a day
# (var.partition_maintenance_schedule, UTC; default 03:17, off-peak and off the 5-minute boundaries
# where the readings arrive). The job (`node dist/partition-maintenance/main.js` in the ingestion
# image) creates the daily telemetry partitions ahead (the migration created today through +3 days)
# and drops whole-day partitions older than var.telemetry_retention_days (TELEMETRY_RETENTION_DAYS).
# The drop takes a brief lock with a 10 s lock_timeout.
#
# RUNBOOK: if this job keeps failing, the partitions run out. After the last existing day (at most 3
# days after the last success) readings fall into the DEFAULT partition (telemetry_default,
# telemetry_alerts_default): they are still stored and still read, but not pruned by day, and the
# DEFAULT partition grows. Fix the cause (job logs, Cloud SQL, database-url, a lock held by a long
# transaction), then run it by hand: `gcloud run jobs execute nextera-partition-maintenance --region
# $REGION`. A successful run creates the missing days again and carves the recent rows out of the
# DEFAULT partition into them. `--args=dist/partition-maintenance/main.js,--days-ahead,7` creates
# more days ahead. The failed-execution alert (monitoring.tf) names this job.
# Toggles: partition_maintenance_enabled (create/destroy the job, its identities and the schedule),
# partition_maintenance_paused (keep it, stop the schedule: DO NOT leave it paused for more than 3
# days). telemetry_retention_days (default 31) is the retention of the readings.

locals {
  partition_maintenance_job_name = "nextera-partition-maintenance"
}

# Runtime identity of the job: Cloud SQL and the database-url secret, nothing else.
resource "google_service_account" "partition_maintenance" {
  count = var.partition_maintenance_enabled ? 1 : 0

  account_id   = "nextera-partition-maintenance"
  display_name = "nextera partition maintenance (Cloud Run Job, telemetry partitions)"

  depends_on = [google_project_service.this]
}

resource "google_project_iam_member" "partition_maintenance_cloudsql_client" {
  count = var.partition_maintenance_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.partition_maintenance[0].email}"
}

resource "google_secret_manager_secret_iam_member" "partition_maintenance_database_url" {
  count = var.partition_maintenance_enabled ? 1 : 0

  secret_id = google_secret_manager_secret.app["database-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.partition_maintenance[0].email}"
}

resource "google_cloud_run_v2_job" "partition_maintenance" {
  count = var.partition_maintenance_enabled ? 1 : 0

  name     = local.partition_maintenance_job_name
  location = var.region
  # Stateless and switched off by partition_maintenance_enabled = false.
  deletion_protection = false

  template {
    task_count  = 1 # one task per execution ...
    parallelism = 1 # ... and never more than one at a time

    template {
      service_account = google_service_account.partition_maintenance[0].email
      timeout         = "600s" # whole-day DROP is fast; the 10 s lock_timeout bounds waiting on a busy table
      max_retries     = 1      # idempotent (create-if-missing, drop-if-old); a lock_timeout failure is retried once

      # No vpc_access: Cloud SQL comes through the built-in connector (the volume below), and the
      # job needs no Redis.
      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [local.sql_connection]
        }
      }

      containers {
        # The ingestion image. Before the first deploy this is the placeholder, which has no node:
        # executions fail until deploy.yml has updated the job (see CLAUDE.md, Deploying).
        image   = var.ingestion_image
        command = ["node"]                               # not the image's entrypoint, so extra args go to the script
        args    = ["dist/partition-maintenance/main.js"] # no --every: one run, then exit

        resources {
          limits = {
            cpu    = "1"
            memory = "512Mi"
          }
        }

        env {
          name  = "NODE_ENV"
          value = "production"
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["database-url"].secret_id
              version = "latest"
            }
          }
        }
        env {
          name  = "TELEMETRY_RETENTION_DAYS"
          value = tostring(var.telemetry_retention_days)
        }

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }
      }
    }
  }

  lifecycle {
    # CI updates the image with `gcloud run jobs update`; Terraform owns everything else.
    ignore_changes = [template[0].template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_project_service.this,
    google_project_iam_member.partition_maintenance_cloudsql_client,
    google_secret_manager_secret_iam_member.partition_maintenance_database_url,
    google_secret_manager_secret_version.app,
  ]
}

# Identity Cloud Scheduler uses to call the Cloud Run Admin API (jobs.run) on this job only. Not
# shared with the other jobs' scheduler SAs: each one can run exactly one job.
resource "google_service_account" "partition_maintenance_scheduler" {
  count = var.partition_maintenance_enabled ? 1 : 0

  account_id   = "nextera-partition-maint-sched" # 29 characters (max 30)
  display_name = "Cloud Scheduler -> Cloud Run Job nextera-partition-maintenance"

  depends_on = [google_project_service.this]
}

resource "google_cloud_run_v2_job_iam_member" "partition_maintenance_scheduler_invoker" {
  count = var.partition_maintenance_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.partition_maintenance[0].name
  location = var.region
  role     = "roles/run.invoker" # includes run.jobs.run
  member   = "serviceAccount:${google_service_account.partition_maintenance_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "partition_maintenance" {
  count = var.partition_maintenance_enabled ? 1 : 0

  name             = local.partition_maintenance_job_name
  region           = var.region
  description      = "Runs the Cloud Run Job ${local.partition_maintenance_job_name}: creates the upcoming daily telemetry partitions and drops those past TELEMETRY_RETENTION_DAYS."
  schedule         = var.partition_maintenance_schedule
  time_zone        = "Etc/UTC"
  paused           = var.partition_maintenance_paused
  attempt_deadline = "60s" # jobs:run returns once the execution has started

  retry_config {
    retry_count = 0 # the job retries itself once; the next daily run creates any missing partition (the migration made today..+3 days)
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.partition_maintenance_job_name}:run"

    oauth_token {
      service_account_email = google_service_account.partition_maintenance_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.this,
    google_cloud_run_v2_job_iam_member.partition_maintenance_scheduler_invoker,
  ]
}
