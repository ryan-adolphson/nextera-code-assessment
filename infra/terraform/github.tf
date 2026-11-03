# GitHub Actions -> GCP without keys: Workload Identity Federation.
# .github/workflows/deploy.yml exchanges the job's GitHub OIDC token for a short-lived token of the
# deployer service account. It builds and pushes the images, runs `prisma migrate deploy` through the
# Cloud SQL Auth Proxy, then deploys nextera-api, nextera-ingestion and nextera-web, and updates the
# image of the demo feed job (demo_feed_enabled), the weather sync job (weather_sync_enabled) and
# the farm rollup job (farm_rollup_enabled).

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"

  depends_on = [google_project_service.this]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }

  attribute_mapping = {
    "google.subject"          = "assertion.sub" # repo:<owner>/<repo>:environment:<env>
    "attribute.repository"    = "assertion.repository"
    "attribute.repository_id" = "assertion.repository_id"
    "attribute.ref"           = "assertion.ref"
  }

  # Tokens from any other repository are rejected at the token exchange. With github_repository_id
  # set, the immutable numeric id must match too: a deleted or renamed repository's name can be
  # re-registered by someone else, its id can't.
  attribute_condition = join(" && ", concat(
    ["assertion.repository == \"${var.github_repository}\""],
    var.github_repository_id == "" ? [] : ["assertion.repository_id == \"${var.github_repository_id}\""],
  ))
}

resource "google_service_account" "deployer" {
  account_id   = "nextera-deployer"
  display_name = "nextera deploys + Prisma migrations (GitHub Actions)"

  depends_on = [google_project_service.this]
}

# Only jobs that run in the GitHub deployment environment may impersonate the deployer. Protect that
# environment (deployment branches: main, optional reviewers) in the repository settings.
resource "google_service_account_iam_member" "deployer_github" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/repo:${var.github_repository}:environment:${var.github_environment}"
}

# Cloud SQL access (roles/cloudsql.client) and the database-url secret: see iam.tf.

resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

# `gcloud run deploy --image` on the three existing services only (Terraform still owns their config).
resource "google_cloud_run_v2_service_iam_member" "deployer_developer" {
  for_each = {
    api       = google_cloud_run_v2_service.api.name
    ingestion = google_cloud_run_v2_service.ingestion.name
    web       = google_cloud_run_v2_service.web.name
  }

  name     = each.value
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

# `gcloud run jobs update --image` on the optional jobs that exist (demo-feed.tf, weather-sync.tf,
# farm-rollup.tf).
resource "google_cloud_run_v2_job_iam_member" "deployer_developer" {
  for_each = merge(
    var.demo_feed_enabled ? { demo_feed = google_cloud_run_v2_job.demo_feed[0].name } : {},
    var.weather_sync_enabled ? { weather_sync = google_cloud_run_v2_job.weather_sync[0].name } : {},
    var.farm_rollup_enabled ? { farm_rollup = google_cloud_run_v2_job.farm_rollup[0].name } : {},
  )

  name     = each.value
  location = var.region
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

# Was count (demo feed only); keeps the existing binding instead of destroying and re-creating it.
moved {
  from = google_cloud_run_v2_job_iam_member.deployer_developer[0]
  to   = google_cloud_run_v2_job_iam_member.deployer_developer["demo_feed"]
}

# Deploying a revision (or updating a job) that runs as a service account requires actAs on that account.
resource "google_service_account_iam_member" "deployer_act_as" {
  for_each = merge(
    {
      api       = google_service_account.api.name
      ingestion = google_service_account.ingestion.name
      web       = google_service_account.web.name
    },
    var.demo_feed_enabled ? { demo_feed = google_service_account.demo_feed[0].name } : {},
    var.weather_sync_enabled ? { weather_sync = google_service_account.weather_sync[0].name } : {},
    var.farm_rollup_enabled ? { farm_rollup = google_service_account.farm_rollup[0].name } : {},
  )

  service_account_id = each.value
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
