# Farm rollup (var.farm_rollup_enabled, on by default: the web app's farm History tab reads its
# table): Cloud Scheduler runs the Cloud Run Job nextera-farm-rollup every 15 minutes
# (var.farm_rollup_schedule, UTC). The job (`node dist/farm-rollup/main.js` in the ingestion image)
# recomputes the 30-minute farm rollups (farm_telemetry_rollups) touched since its watermark on
# telemetry.created_at, plus moved turbines and the current day, and prunes rows older than 190 days.
# An advisory lock in Postgres makes overlapping runs harmless; it exits non-zero on failure.
# Rebuilds: run `npm run rollup -- --full` (or `--from YYYY-MM-DD`) through the Cloud SQL Auth Proxy,
# or execute the job with other args
# (`gcloud run jobs execute nextera-farm-rollup --args=dist/farm-rollup/main.js,--full`).
# Toggles: farm_rollup_enabled (create/destroy the job, its identities and the schedule),
# farm_rollup_paused (keep it, stop the schedule; the History tab then goes stale).

locals {
  farm_rollup_job_name = "nextera-farm-rollup"
}

# Runtime identity of the job: Cloud SQL, the database-url secret and the redis-url secret, nothing else.
resource "google_service_account" "farm_rollup" {
  count = var.farm_rollup_enabled ? 1 : 0

  account_id   = "nextera-farm-rollup"
  display_name = "nextera farm rollup (Cloud Run Job, telemetry -> farm_telemetry_rollups)"

  depends_on = [google_project_service.this]
}

resource "google_project_iam_member" "farm_rollup_cloudsql_client" {
  count = var.farm_rollup_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.farm_rollup[0].email}"
}

resource "google_secret_manager_secret_iam_member" "farm_rollup_database_url" {
  count = var.farm_rollup_enabled ? 1 : 0

  secret_id = google_secret_manager_secret.app["database-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.farm_rollup[0].email}"
}

resource "google_secret_manager_secret_iam_member" "farm_rollup_redis_url" {
  count = var.farm_rollup_enabled ? 1 : 0

  secret_id = google_secret_manager_secret.app["redis-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.farm_rollup[0].email}"
}

resource "google_cloud_run_v2_job" "farm_rollup" {
  count = var.farm_rollup_enabled ? 1 : 0

  name     = local.farm_rollup_job_name
  location = var.region
  # Stateless (the rollups live in Cloud SQL and can be rebuilt with --full) and switched off by
  # farm_rollup_enabled = false.
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.farm_rollup[0].email
      timeout         = "300s" # an incremental run takes seconds; a --full rebuild should fit too
      max_retries     = 1      # the upsert is idempotent and the lock serialises runs

      # Direct VPC egress for Memorystore (the Cloud SQL socket needs none), like nextera-ingestion.
      # The job publishes farm-rollup.completed to Redis, best effort: without this block a Redis
      # timeout would only show up as a log line.
      vpc_access {
        network_interfaces {
          network    = local.vpc_network_interface.network
          subnetwork = local.vpc_network_interface.subnetwork
        }
        egress = "PRIVATE_RANGES_ONLY"
      }

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
        command = ["node"]                     # not the image's entrypoint, so extra args go to the script
        args    = ["dist/farm-rollup/main.js"] # no args: incremental since the watermark

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
          name = "REDIS_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app["redis-url"].secret_id
              version = "latest"
            }
          }
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
    google_project_iam_member.farm_rollup_cloudsql_client,
    google_secret_manager_secret_iam_member.farm_rollup_database_url,
    google_secret_manager_secret_iam_member.farm_rollup_redis_url,
    google_secret_manager_secret_version.app,
  ]
}

# Identity Cloud Scheduler uses to call the Cloud Run Admin API (jobs.run) on this job only. Not
# shared with the other jobs' scheduler SAs: each one can run exactly one job.
resource "google_service_account" "farm_rollup_scheduler" {
  count = var.farm_rollup_enabled ? 1 : 0

  account_id   = "nextera-farm-rollup-scheduler" # 29 characters (max 30)
  display_name = "Cloud Scheduler -> Cloud Run Job nextera-farm-rollup"

  depends_on = [google_project_service.this]
}

resource "google_cloud_run_v2_job_iam_member" "farm_rollup_scheduler_invoker" {
  count = var.farm_rollup_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.farm_rollup[0].name
  location = var.region
  role     = "roles/run.invoker" # includes run.jobs.run
  member   = "serviceAccount:${google_service_account.farm_rollup_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "farm_rollup" {
  count = var.farm_rollup_enabled ? 1 : 0

  name             = local.farm_rollup_job_name
  region           = var.region
  description      = "Runs the Cloud Run Job ${local.farm_rollup_job_name}: incremental 30-minute farm rollups for the History tab."
  schedule         = var.farm_rollup_schedule
  time_zone        = "Etc/UTC"
  paused           = var.farm_rollup_paused
  attempt_deadline = "60s" # jobs:run returns once the execution has started

  retry_config {
    retry_count = 0 # a missed run is caught up by the next one (the watermark only advances on success)
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.farm_rollup_job_name}:run"

    oauth_token {
      service_account_email = google_service_account.farm_rollup_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.this,
    google_cloud_run_v2_job_iam_member.farm_rollup_scheduler_invoker,
  ]
}
