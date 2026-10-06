# Turbines (or an edge gateway) publish readings (JSON in telemetry.csv format) to the "telemetry"
# topic. A push subscription delivers each message to the ingestion worker over HTTPS with an OIDC
# token; failures are retried with backoff and, after pubsub_max_delivery_attempts, moved to the
# dead-letter topic.

locals {
  pubsub_service_agent = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_topic" "telemetry" {
  name                       = "telemetry"
  message_retention_duration = "604800s" # 7 days: allows replaying via seek

  depends_on = [google_project_service.this]
}

resource "google_pubsub_topic" "telemetry_dead_letter" {
  name = "telemetry-dead-letter"

  depends_on = [google_project_service.this]
}

# Keeps dead-lettered messages for inspection / manual replay.
resource "google_pubsub_subscription" "telemetry_dead_letter" {
  name                       = "telemetry-dead-letter"
  topic                      = google_pubsub_topic.telemetry_dead_letter.id
  message_retention_duration = "604800s"
  ack_deadline_seconds       = 60
  expiration_policy {
    ttl = "" # never expire
  }
}

resource "google_pubsub_subscription" "telemetry_ingestion" {
  name                       = "telemetry-ingestion"
  topic                      = google_pubsub_topic.telemetry.id
  ack_deadline_seconds       = 60 # must exceed the worker's processing time
  message_retention_duration = "604800s"

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.ingestion.uri}/pubsub/telemetry"
    oidc_token {
      service_account_email = google_service_account.pubsub_push.email
      audience              = google_cloud_run_v2_service.ingestion.uri
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.telemetry_dead_letter.id
    max_delivery_attempts = var.pubsub_max_delivery_attempts
  }

  expiration_policy {
    ttl = "" # never expire
  }

  depends_on = [
    google_cloud_run_v2_service_iam_member.ingestion_invoker,
    google_pubsub_topic_iam_member.dead_letter_publisher,
  ]
}

# The Pub/Sub service agent must be able to forward to the DLQ and ack the original message.
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  topic  = google_pubsub_topic.telemetry_dead_letter.id
  role   = "roles/pubsub.publisher"
  member = local.pubsub_service_agent
}

resource "google_pubsub_subscription_iam_member" "dead_letter_subscriber" {
  subscription = google_pubsub_subscription.telemetry_ingestion.id
  role         = "roles/pubsub.subscriber"
  member       = local.pubsub_service_agent
}

# Lets the Pub/Sub service agent mint OIDC tokens for the push identity
# (granted automatically in newer projects; explicit here for older ones).
resource "google_service_account_iam_member" "pubsub_token_creator" {
  service_account_id = google_service_account.pubsub_push.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.pubsub_service_agent
}
