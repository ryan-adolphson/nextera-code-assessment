# Anomaly rollup (var.anomaly_rollup_enabled, on by default): Cloud Scheduler runs the Cloud Run Job
# nextera-anomaly-rollup hourly (var.anomaly_rollup_schedule, UTC; default minute 7). The job (`node
# dist/anomaly-rollup/main.js` in the ingestion image) rolls up the anomaly episodes from the
# readings (DATABASE_URL only). The first run takes about 70 s at 1M turbines, later runs seconds, so the
# timeout is 15 min. Rebuilds: `gcloud run jobs execute nextera-anomaly-rollup --region $REGION
# --args=dist/anomaly-rollup/main.js,--from,YYYY-MM-DD`.
# Toggles: anomaly_rollup_enabled (create/destroy), anomaly_rollup_paused (keep it, stop the schedule).

locals {
  anomaly_rollup_job_name = "nextera-anomaly-rollup"
}

# Runtime identity of the job: Cloud SQL and the database-url secret, nothing else.
resource "google_service_account" "anomaly_rollup" {
  count = var.anomaly_rollup_enabled ? 1 : 0

  account_id   = "nextera-anomaly-rollup"
  display_name = "nextera anomaly rollup (Cloud Run Job, telemetry -> anomaly episodes)"

  depends_on = [google_project_service.this]
}

resource "google_project_iam_member" "anomaly_rollup_cloudsql_client" {
  count = var.anomaly_rollup_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.anomaly_rollup[0].email}"
}

resource "google_secret_manager_secret_iam_member" "anomaly_rollup_database_url" {
  count = var.anomaly_rollup_enabled ? 1 : 0

  secret_id = google_secret_manager_secret.app["database-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.anomaly_rollup[0].email}"
}

resource "google_cloud_run_v2_job" "anomaly_rollup" {
  count = var.anomaly_rollup_enabled ? 1 : 0

  name     = local.anomaly_rollup_job_name
  location = var.region
  # Stateless and switched off by anomaly_rollup_enabled = false.
  deletion_protection = false

  template {
    task_count  = 1 # one task per execution ...
    parallelism = 1 # ... and never more than one at a time

    template {
      service_account = google_service_account.anomaly_rollup[0].email
      timeout         = "900s" # first run ~70 s at 1M turbines, later runs seconds; generous for --from rebuilds
      max_retries     = 1      # idempotent upserts

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
        command = ["node"]                        # not the image's entrypoint, so extra args go to the script
        args    = ["dist/anomaly-rollup/main.js"] # no --every: one run, then exit

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
    google_project_iam_member.anomaly_rollup_cloudsql_client,
    google_secret_manager_secret_iam_member.anomaly_rollup_database_url,
    google_secret_manager_secret_version.app,
  ]
}

# Identity Cloud Scheduler uses to call the Cloud Run Admin API (jobs.run) on this job only. Not
# shared with the other jobs' scheduler SAs: each one can run exactly one job.
resource "google_service_account" "anomaly_rollup_scheduler" {
  count = var.anomaly_rollup_enabled ? 1 : 0

  account_id   = "nextera-anomaly-rollup-sched" # 28 characters (max 30)
  display_name = "Cloud Scheduler -> Cloud Run Job nextera-anomaly-rollup"

  depends_on = [google_project_service.this]
}

resource "google_cloud_run_v2_job_iam_member" "anomaly_rollup_scheduler_invoker" {
  count = var.anomaly_rollup_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.anomaly_rollup[0].name
  location = var.region
  role     = "roles/run.invoker" # includes run.jobs.run
  member   = "serviceAccount:${google_service_account.anomaly_rollup_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "anomaly_rollup" {
  count = var.anomaly_rollup_enabled ? 1 : 0

  name             = local.anomaly_rollup_job_name
  region           = var.region
  description      = "Runs the Cloud Run Job ${local.anomaly_rollup_job_name}: rolls up anomaly episodes from the readings."
  schedule         = var.anomaly_rollup_schedule
  time_zone        = "Etc/UTC"
  paused           = var.anomaly_rollup_paused
  attempt_deadline = "60s" # jobs:run returns once the execution has started

  retry_config {
    retry_count = 0 # a missed run is caught up by the next one
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.anomaly_rollup_job_name}:run"

    oauth_token {
      service_account_email = google_service_account.anomaly_rollup_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.this,
    google_cloud_run_v2_job_iam_member.anomaly_rollup_scheduler_invoker,
  ]
}
