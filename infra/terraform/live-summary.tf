# Live summary (var.live_summary_enabled, on by default): Cloud Scheduler runs the Cloud Run Job
# nextera-live-summary every minute (var.live_summary_schedule, UTC). The job (`node
# dist/live-summary/main.js` in the ingestion image) rebuilds the live fleet summary from the latest
# readings and publishes it to Redis (DATABASE_URL, REDIS_URL).
#
# COST: one execution per minute is about 43,200 a month. Cloud Run Jobs bill vCPU-seconds and
# GiB-seconds (1 vCPU, 512Mi) per execution: about 5-25 USD a month for 5-20 s a run, roughly 10 USD
# at 10 s (list prices, europe/us tier 1, before the free tier; unmeasured). Cloud Scheduler itself is
# free for the first 3 jobs per billing account, then 0.10 USD per job. Slow it down with
# live_summary_schedule (e.g. "*/5 * * * *" is a fifth of the cost) or pause it.
# A run ends within 50 s and the schedule fires after 60 s, so executions do not overlap;
# parallelism = 1 and task_count = 1 keep one task per execution. No retries: the next minute replaces it.
# Toggles: live_summary_enabled (create/destroy), live_summary_paused (keep it, stop the schedule;
# the live summary then goes stale).

locals {
  live_summary_job_name = "nextera-live-summary"
}

# Runtime identity of the job: Cloud SQL and the database-url secret and the redis-url secret, nothing else.
resource "google_service_account" "live_summary" {
  count = var.live_summary_enabled ? 1 : 0

  account_id   = "nextera-live-summary"
  display_name = "nextera live summary (Cloud Run Job, telemetry -> live summary + Redis)"

  depends_on = [google_project_service.this]
}

resource "google_project_iam_member" "live_summary_cloudsql_client" {
  count = var.live_summary_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.live_summary[0].email}"
}

resource "google_secret_manager_secret_iam_member" "live_summary_database_url" {
  count = var.live_summary_enabled ? 1 : 0

  secret_id = google_secret_manager_secret.app["database-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.live_summary[0].email}"
}

resource "google_secret_manager_secret_iam_member" "live_summary_redis_url" {
  count = var.live_summary_enabled ? 1 : 0

  secret_id = google_secret_manager_secret.app["redis-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.live_summary[0].email}"
}

resource "google_cloud_run_v2_job" "live_summary" {
  count = var.live_summary_enabled ? 1 : 0

  name     = local.live_summary_job_name
  location = var.region
  # Stateless and switched off by live_summary_enabled = false.
  deletion_protection = false

  template {
    task_count  = 1 # one task per execution ...
    parallelism = 1 # ... and never more than one at a time

    template {
      service_account = google_service_account.live_summary[0].email
      timeout         = "50s" # well under the 1-minute schedule, so executions never overlap
      max_retries     = 0     # the next minute's run replaces this one

      # Direct VPC egress for Memorystore (the Cloud SQL socket needs none), like nextera-ingestion.
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
        command = ["node"]                      # not the image's entrypoint, so extra args go to the script
        args    = ["dist/live-summary/main.js"] # no --every: one run, then exit

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
    google_project_iam_member.live_summary_cloudsql_client,
    google_secret_manager_secret_iam_member.live_summary_database_url,
    google_secret_manager_secret_version.app,
  ]
}

# Identity Cloud Scheduler uses to call the Cloud Run Admin API (jobs.run) on this job only. Not
# shared with the other jobs' scheduler SAs: each one can run exactly one job.
resource "google_service_account" "live_summary_scheduler" {
  count = var.live_summary_enabled ? 1 : 0

  account_id   = "nextera-live-summary-sched" # 26 characters (max 30)
  display_name = "Cloud Scheduler -> Cloud Run Job nextera-live-summary"

  depends_on = [google_project_service.this]
}

resource "google_cloud_run_v2_job_iam_member" "live_summary_scheduler_invoker" {
  count = var.live_summary_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.live_summary[0].name
  location = var.region
  role     = "roles/run.invoker" # includes run.jobs.run
  member   = "serviceAccount:${google_service_account.live_summary_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "live_summary" {
  count = var.live_summary_enabled ? 1 : 0

  name             = local.live_summary_job_name
  region           = var.region
  description      = "Runs the Cloud Run Job ${local.live_summary_job_name}: rebuilds the live fleet summary and publishes it over Redis."
  schedule         = var.live_summary_schedule
  time_zone        = "Etc/UTC"
  paused           = var.live_summary_paused
  attempt_deadline = "60s" # jobs:run returns once the execution has started

  retry_config {
    retry_count = 0 # a missed minute is replaced by the next one
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.live_summary_job_name}:run"

    oauth_token {
      service_account_email = google_service_account.live_summary_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.this,
    google_cloud_run_v2_job_iam_member.live_summary_scheduler_invoker,
  ]
}
