# Daily weather sync (optional, var.weather_sync_enabled): Cloud Scheduler runs the Cloud Run Job
# nextera-weather-sync once a day (var.weather_sync_schedule, UTC). The job (`node
# dist/weather-sync/main.js` in the ingestion image) fetches the last 7 UTC days of 15-minute weather per
# farm from Open-Meteo and upserts 30-minute buckets into farm_weather (the newer fetch wins).
# It exits non-zero if any farm failed. Backfills: run `npm run weather:sync -- --from … --to …`
# through the Cloud SQL Auth Proxy, or execute the job with other args (`gcloud run jobs execute
# nextera-weather-sync --args=dist/weather-sync/main.js,--from,2026-01-01,--to,2026-01-31`).
# Toggles: weather_sync_enabled (create/destroy the job, its identities and the schedule),
# weather_sync_paused (keep it, stop the schedule), open_meteo_api_key_enabled (paid API key).

locals {
  weather_sync_job_name = "nextera-weather-sync"
  # The job reads the key only when both switches are on.
  weather_sync_api_key = var.weather_sync_enabled && var.open_meteo_api_key_enabled
}

# Open-Meteo API key (paid `customer-*` hosts; the free API is non-commercial only). Like jwt-secret,
# Terraform creates the secret but never its value, so the key stays out of state. Add a version
# before the job runs with it, or its executions fail:
#   tf apply -target=google_secret_manager_secret.open_meteo_api_key
#   printf %s '<key>' | gcloud secrets versions add open-meteo-api-key --data-file=-
resource "google_secret_manager_secret" "open_meteo_api_key" {
  count = var.open_meteo_api_key_enabled ? 1 : 0

  secret_id = "open-meteo-api-key"
  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}

# Runtime identity of the job: Cloud SQL and the database-url secret (+ the API key), nothing else.
resource "google_service_account" "weather_sync" {
  count = var.weather_sync_enabled ? 1 : 0

  account_id   = "nextera-weather-sync"
  display_name = "nextera weather sync (Cloud Run Job, Open-Meteo -> Cloud SQL)"

  depends_on = [google_project_service.this]
}

resource "google_project_iam_member" "weather_sync_cloudsql_client" {
  count = var.weather_sync_enabled ? 1 : 0

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.weather_sync[0].email}"
}

resource "google_secret_manager_secret_iam_member" "weather_sync_database_url" {
  count = var.weather_sync_enabled ? 1 : 0

  secret_id = google_secret_manager_secret.app["database-url"].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.weather_sync[0].email}"
}

resource "google_secret_manager_secret_iam_member" "weather_sync_api_key" {
  count = local.weather_sync_api_key ? 1 : 0

  secret_id = google_secret_manager_secret.open_meteo_api_key[0].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.weather_sync[0].email}"
}

resource "google_cloud_run_v2_job" "weather_sync" {
  count = var.weather_sync_enabled ? 1 : 0

  name     = local.weather_sync_job_name
  location = var.region
  # Stateless (the data lives in Cloud SQL) and switched off by weather_sync_enabled = false.
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.weather_sync[0].email
      timeout         = "600s" # 7 days x every farm, sequential requests with retries
      max_retries     = 1      # the upsert is idempotent, so a retry only repeats work

      # No vpc_access: Cloud SQL comes through the built-in connector (the volume below), the job
      # needs no Redis, and Open-Meteo is on the public internet.
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
        args    = ["dist/weather-sync/main.js"] # no args: the last 7 UTC days, all farms

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
        dynamic "env" {
          for_each = local.weather_sync_api_key ? [google_secret_manager_secret.open_meteo_api_key[0].secret_id] : []
          content {
            name = "OPEN_METEO_API_KEY"
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
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
    google_project_iam_member.weather_sync_cloudsql_client,
    google_secret_manager_secret_iam_member.weather_sync_database_url,
    google_secret_manager_secret_iam_member.weather_sync_api_key,
    google_secret_manager_secret_version.app,
  ]
}

# Identity Cloud Scheduler uses to call the Cloud Run Admin API (jobs.run) on this job only. Not
# shared with the demo feed's scheduler SA: each one can run exactly one job.
resource "google_service_account" "weather_sync_scheduler" {
  count = var.weather_sync_enabled ? 1 : 0

  account_id   = "nextera-weather-sync-scheduler" # 30 characters, the maximum
  display_name = "Cloud Scheduler -> Cloud Run Job nextera-weather-sync"

  depends_on = [google_project_service.this]
}

resource "google_cloud_run_v2_job_iam_member" "weather_sync_scheduler_invoker" {
  count = var.weather_sync_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.weather_sync[0].name
  location = var.region
  role     = "roles/run.invoker" # includes run.jobs.run
  member   = "serviceAccount:${google_service_account.weather_sync_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "weather_sync" {
  count = var.weather_sync_enabled ? 1 : 0

  name             = local.weather_sync_job_name
  region           = var.region
  description      = "Runs the Cloud Run Job ${local.weather_sync_job_name}: Open-Meteo weather of the last 7 UTC days per farm."
  schedule         = var.weather_sync_schedule
  time_zone        = "Etc/UTC"
  paused           = var.weather_sync_paused
  attempt_deadline = "60s" # jobs:run returns once the execution has started

  retry_config {
    retry_count          = 2 # only if starting the execution fails; a duplicate run is harmless (upsert)
    min_backoff_duration = "60s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.weather_sync_job_name}:run"

    oauth_token {
      service_account_email = google_service_account.weather_sync_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.this,
    google_cloud_run_v2_job_iam_member.weather_sync_scheduler_invoker,
  ]
}
