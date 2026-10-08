# Live demo feed (optional, var.demo_feed_enabled): every 5 minutes Cloud Scheduler runs the Cloud
# Run Job nextera-demo-feed, which publishes one reading per demo turbine to the telemetry topic
# (`node dist/demo-feed/main.js --once` in the ingestion image). The readings take the normal path:
# Pub/Sub push -> nextera-ingestion -> Cloud SQL + Redis -> SSE. Run `npm run db:seed:demo` against
# Cloud SQL first: readings for turbines the database doesn't know get 400 and end in the DLQ.
# Locally: the compose service demo-feed. Toggle: demo_feed_enabled (create/destroy everything here),
# demo_feed_paused (keep it, stop the schedule).

locals {
  demo_feed_job_name = "nextera-demo-feed"
}

# Runtime identity of the job: publishes to the telemetry topic, nothing else (no DB, Redis or secrets).
resource "google_service_account" "demo_feed" {
  count = var.demo_feed_enabled ? 1 : 0

  account_id   = "nextera-demo-feed"
  display_name = "nextera demo feed (Cloud Run Job, publishes demo telemetry)"
}

resource "google_pubsub_topic_iam_member" "demo_feed_publisher" {
  count = var.demo_feed_enabled ? 1 : 0

  topic  = google_pubsub_topic.telemetry.id
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.demo_feed[0].email}"
}

resource "google_cloud_run_v2_job" "demo_feed" {
  count = var.demo_feed_enabled ? 1 : 0

  name     = local.demo_feed_job_name
  location = var.region
  # Stateless and switched off by demo_feed_enabled = false, which must be able to destroy it.
  deletion_protection = false

  template {
    task_count = 1

    template {
      service_account = google_service_account.demo_feed[0].email
      timeout         = "60s" # one tick: 24 publishes
      max_retries     = 1     # a failed publish exits 1; the next tick comes 5 minutes later anyway

      containers {
        # The ingestion image. Before the first deploy this is the placeholder, which has no node:
        # executions fail until deploy.yml has updated the job (see CLAUDE.md, Deploying).
        image   = var.ingestion_image
        command = ["node"] # not the image's entrypoint: it would turn a lone "--once" into `node --once`
        args    = ["dist/demo-feed/main.js", "--once"]

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
          name  = "DEMO_FEED_ENABLED"
          value = "true" # the switch is demo_feed_enabled: the job only exists when it is on
        }
        env {
          name  = "PUBSUB_TOPIC"
          value = google_pubsub_topic.telemetry.name
        }
        env {
          name  = "GOOGLE_CLOUD_PROJECT"
          value = var.project_id
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
    google_pubsub_topic_iam_member.demo_feed_publisher,
  ]
}

# Identity Cloud Scheduler uses to call the Cloud Run Admin API (jobs.run) on this job only.
resource "google_service_account" "demo_feed_scheduler" {
  count = var.demo_feed_enabled ? 1 : 0

  account_id   = "nextera-demo-feed-scheduler"
  display_name = "Cloud Scheduler -> Cloud Run Job nextera-demo-feed"
}

resource "google_cloud_run_v2_job_iam_member" "demo_feed_scheduler_invoker" {
  count = var.demo_feed_enabled ? 1 : 0

  name     = google_cloud_run_v2_job.demo_feed[0].name
  location = var.region
  role     = "roles/run.invoker" # includes run.jobs.run
  member   = "serviceAccount:${google_service_account.demo_feed_scheduler[0].email}"
}

resource "google_cloud_scheduler_job" "demo_feed" {
  count = var.demo_feed_enabled ? 1 : 0

  name             = local.demo_feed_job_name
  region           = var.region
  description      = "Runs the Cloud Run Job ${local.demo_feed_job_name}: one demo telemetry tick."
  schedule         = "*/5 * * * *" # the telemetry interval
  time_zone        = "Etc/UTC"
  paused           = var.demo_feed_paused
  attempt_deadline = "60s"

  retry_config {
    retry_count = 0 # a missed tick is just a gap; the next one comes in 5 minutes
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${local.demo_feed_job_name}:run"

    oauth_token {
      service_account_email = google_service_account.demo_feed_scheduler[0].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [
    google_project_service.this,
    google_cloud_run_v2_job_iam_member.demo_feed_scheduler_invoker,
  ]
}
