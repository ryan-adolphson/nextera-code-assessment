variable "project_id" {
  description = "GCP project ID."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, Memorystore and Artifact Registry. Cloud Run domain mappings must be supported here (e.g. us-central1)."
  type        = string
  default     = "us-central1"
}

variable "deletion_protection" {
  description = "Protect Cloud SQL and Cloud Run resources from accidental deletion. Set false only for throwaway environments."
  type        = bool
  default     = true
}

# --- Domains ------------------------------------------------------------------

variable "api_domain" {
  description = "Custom domain for the API (e.g. api.example.com), mapped to Cloud Run. Empty = use the run.app URL only."
  type        = string
  default     = ""
}

variable "web_domain" {
  description = "Custom domain for the Angular app (e.g. app.example.com), mapped to Cloud Run nextera-web. Empty = use the run.app URL only."
  type        = string
  default     = ""
}

# --- Database ---------------------------------------------------------------

variable "db_version" {
  description = "Cloud SQL database version. Keep the major version in step with docker-compose (postgres:18)."
  type        = string
  default     = "POSTGRES_18"
}

variable "db_tier" {
  description = "Cloud SQL machine tier. db-g1-small allows ~50 connections; size with (api + ingestion max instances) x db_pool_max."
  type        = string
  default     = "db-g1-small"
}

variable "db_high_availability" {
  description = "REGIONAL (HA failover) instead of ZONAL."
  type        = bool
  default     = false
}

variable "db_pool_max" {
  description = "Prisma pg pool size per instance (DB_POOL_MAX). (api_max_instances + ingestion_max_instances) x db_pool_max must stay below max_connections."
  type        = number
  default     = 4
}

# --- Cloud Run --------------------------------------------------------------
# Images are placeholders for the first apply. CI deploys real images afterwards
# (Terraform ignores image changes, see lifecycle blocks in run.tf).

variable "api_image" {
  type    = string
  default = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "ingestion_image" {
  type    = string
  default = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "web_image" {
  type    = string
  default = "us-docker.pkg.dev/cloudrun/container/hello"
}

variable "web_max_instances" {
  description = "Caps the static web service (nginx); each instance serves hundreds of concurrent requests."
  type        = number
  default     = 3
}

variable "api_min_instances" {
  description = "Warm API instances. >= 1 avoids cold starts on SSE reconnects."
  type        = number
  default     = 1
}

variable "api_max_instances" {
  type    = number
  default = 5
}

variable "api_concurrency" {
  description = "Concurrent requests per API instance. Each open SSE stream holds one slot for its whole lifetime."
  type        = number
  default     = 250
}

variable "ingestion_max_instances" {
  description = "Caps worker scale-out (and DB connections) during message bursts; Pub/Sub buffers the rest."
  type        = number
  default     = 5
}

variable "ingestion_concurrency" {
  description = "Concurrent Pub/Sub pushes per worker instance."
  type        = number
  default     = 20
}

# --- Pub/Sub ----------------------------------------------------------------

variable "pubsub_max_delivery_attempts" {
  description = "Deliveries before a message moves to the dead-letter topic (5-100)."
  type        = number
  default     = 5
}

variable "ingestion_invokers" {
  description = "Extra principals allowed to call the private ingestion worker, e.g. to upload CSVs to POST /ingest/telemetry (\"user:ops@example.com\", \"group:...\", \"serviceAccount:...\")."
  type        = list(string)
  default     = []
}

# --- GitHub Actions (CI/CD) ---------------------------------------------------

variable "github_repository" {
  description = "GitHub repository (\"owner/repo\") whose Actions may deploy and run migrations via Workload Identity Federation."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository must look like \"owner/repo\"."
  }
}

variable "github_environment" {
  description = "GitHub deployment environment whose jobs may impersonate the deployer service account (.github/workflows/deploy.yml)."
  type        = string
  default     = "production"
}

# --- Auth (API) ---------------------------------------------------------------
# The signing key is the Secret Manager secret jwt-secret (secrets.tf); these are plain claims.

variable "jwt_issuer" {
  description = "JWT `iss` claim the API signs and requires (JWT_ISSUER)."
  type        = string
  default     = "nextera-api"
}

variable "jwt_audience" {
  description = "JWT `aud` claim the API signs and requires (JWT_AUDIENCE)."
  type        = string
  default     = "nextera-web"
}
