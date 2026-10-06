output "api_url" {
  description = "Public API base URL (custom domain if configured). nextera-web gets it + \"/api\" as API_BASE_URL."
  value       = local.api_url
}

output "api_run_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "api_dns_records" {
  description = "DNS records to create for api_domain (the certificate provisions once they resolve)."
  value       = try(google_cloud_run_domain_mapping.api[0].status[0].resource_records, [])
}

output "web_url" {
  description = "Public URL of the Angular app (custom domain if configured, else the deterministic run.app URL)."
  value       = local.web_url
}

output "web_origins" {
  description = "Browser origins the API allows (CORS_ORIGINS): the web service's deterministic run.app URL and web_domain."
  value       = local.web_origins
}

output "web_dns_records" {
  description = "DNS records to create for web_domain (the certificate provisions once they resolve)."
  value       = try(google_cloud_run_domain_mapping.web[0].status[0].resource_records, [])
}

output "registry" {
  description = "Docker registry prefix for the api / ingestion / web images (GitHub variable GCP_REGISTRY)."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "telemetry_topic" {
  description = "Producers publish telemetry readings (telemetry.csv format) here."
  value       = google_pubsub_topic.telemetry.id
}

output "telemetry_dead_letter_subscription" {
  description = "Messages that failed pubsub_max_delivery_attempts times; inspect with `gcloud pubsub subscriptions pull`."
  value       = google_pubsub_subscription.telemetry_dead_letter.id
}

output "sql_connection_name" {
  description = "Cloud SQL Auth Proxy target (GitHub variable CLOUDSQL_INSTANCE; locally: cloud-sql-proxy <this>)."
  value       = google_sql_database_instance.main.connection_name
}

output "services" {
  value = {
    api       = google_cloud_run_v2_service.api.name
    ingestion = google_cloud_run_v2_service.ingestion.name
    web       = google_cloud_run_v2_service.web.name
  }
}

output "github_workload_identity_provider" {
  description = "Workload Identity Federation provider for google-github-actions/auth (GitHub variable GCP_WIF_PROVIDER)."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_deployer_service_account" {
  description = "Service account GitHub Actions impersonates to deploy and migrate (GitHub variable GCP_DEPLOYER_SA)."
  value       = google_service_account.deployer.email
}

output "github_actions_variables" {
  description = "Repository variables for .github/workflows/deploy.yml (not secrets). See CLAUDE.md, Deploying."
  value = {
    GCP_PROJECT_ID    = var.project_id
    GCP_REGION        = var.region
    GCP_WIF_PROVIDER  = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOYER_SA   = google_service_account.deployer.email
    GCP_REGISTRY      = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
    CLOUDSQL_INSTANCE = google_sql_database_instance.main.connection_name
  }
}
