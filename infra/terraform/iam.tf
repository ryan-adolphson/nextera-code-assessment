# One identity per workload, least privilege.

resource "google_service_account" "api" {
  account_id   = "nextera-api"
  display_name = "nextera API + SSE (Cloud Run service)"
}

resource "google_service_account" "ingestion" {
  account_id   = "nextera-ingestion"
  display_name = "nextera ingestion worker (Cloud Run service)"
}

resource "google_service_account" "web" {
  account_id   = "nextera-web"
  display_name = "nextera Angular app (Cloud Run service, no roles)"
}

# Identity Pub/Sub uses to sign the OIDC token on each push to the ingestion worker.
resource "google_service_account" "pubsub_push" {
  account_id   = "nextera-pubsub-push"
  display_name = "Pub/Sub push to nextera-ingestion"
}

resource "google_project_iam_member" "cloudsql_client" {
  for_each = {
    api       = google_service_account.api.email
    ingestion = google_service_account.ingestion.email
    deployer  = google_service_account.deployer.email # GitHub Actions: prisma migrate deploy via Cloud SQL Auth Proxy
  }

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${each.value}"
}

resource "google_secret_manager_secret_iam_member" "access" {
  for_each = {
    "api-database-url"       = { secret = "database-url", sa = google_service_account.api.email }
    "api-redis-url"          = { secret = "redis-url", sa = google_service_account.api.email }
    "ingestion-database-url" = { secret = "database-url", sa = google_service_account.ingestion.email }
    "ingestion-redis-url"    = { secret = "redis-url", sa = google_service_account.ingestion.email }
    "deployer-database-url"  = { secret = "database-url", sa = google_service_account.deployer.email }
  }

  secret_id = google_secret_manager_secret.app[each.value.secret].id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${each.value.sa}"
}

# The Pub/Sub push identity may invoke the (private) ingestion worker; see also ingestion_csv_uploaders.
resource "google_cloud_run_v2_service_iam_member" "ingestion_invoker" {
  name     = google_cloud_run_v2_service.ingestion.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.pubsub_push.email}"
}

# People / systems that upload telemetry CSVs (POST /ingest/telemetry) with an identity token.
resource "google_cloud_run_v2_service_iam_member" "ingestion_csv_uploaders" {
  for_each = toset(var.ingestion_invokers)

  name     = google_cloud_run_v2_service.ingestion.name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.value
}
