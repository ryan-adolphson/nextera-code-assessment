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
  description = "Concurrent Pub/Sub pushes per worker instance. High on purpose: the worker batches pushes into one DB flush at a time, so DB connections do not grow with concurrency, and the batch (INGEST_BATCH_MAX) and queue limit (INGEST_MAX_QUEUED, 500) can only fill if more requests than that can be in flight."
  type        = number
  default     = 100
}

# --- Pub/Sub ----------------------------------------------------------------

variable "pubsub_max_delivery_attempts" {
  description = "Deliveries before a message moves to the dead-letter topic (5-100). 10 attempts with the 10-600 s backoff in pubsub.tf is about 40 minutes of retries: the worker answers 503 when its queue is full (counted as a failed delivery), so valid readings survive an overload, while an invalid payload takes that long to reach the dead-letter topic."
  type        = number
  default     = 10
}

variable "ingestion_invokers" {
  description = "Extra principals allowed to call the private ingestion worker, e.g. to upload CSVs to POST /ingest/telemetry (\"user:ops@example.com\", \"group:...\", \"serviceAccount:...\")."
  type        = list(string)
  default     = []
}

# --- Demo feed (demo-feed.tf) -------------------------------------------------

variable "demo_feed_enabled" {
  description = "Create the live demo feed: Cloud Run Job nextera-demo-feed (one reading per demo turbine to the telemetry topic) + a Cloud Scheduler trigger every 5 minutes. Run `npm run db:seed:demo` against Cloud SQL first."
  type        = bool
  default     = false
}

variable "demo_feed_paused" {
  description = "Pause the demo feed's Cloud Scheduler trigger (keeps the job). Only used when demo_feed_enabled."
  type        = bool
  default     = false
}

# --- Weather sync (weather-sync.tf) ---------------------------------------------

variable "weather_sync_enabled" {
  description = "Create the daily weather sync: Cloud Run Job nextera-weather-sync (Open-Meteo hourly weather of the last 7 UTC days per farm -> Cloud SQL) + a Cloud Scheduler trigger (weather_sync_schedule)."
  type        = bool
  default     = false
}

variable "weather_sync_paused" {
  description = "Pause the weather sync's Cloud Scheduler trigger (keeps the job). Only used when weather_sync_enabled."
  type        = bool
  default     = false
}

variable "weather_sync_schedule" {
  description = "Cron schedule (UTC) of the weather sync. Default 01:30 every day."
  type        = string
  default     = "30 1 * * *"

  validation {
    condition     = length(split(" ", trimspace(var.weather_sync_schedule))) == 5
    error_message = "weather_sync_schedule must be a five-field cron expression such as \"30 1 * * *\"."
  }
}

variable "open_meteo_api_key_enabled" {
  description = "Create the Secret Manager secret open-meteo-api-key (value added by hand, never by Terraform) and pass it to the weather sync job as OPEN_METEO_API_KEY (paid customer-* hosts). Required for commercial use: the free API is non-commercial only."
  type        = bool
  default     = false
}

# --- Farm rollup (farm-rollup.tf) -----------------------------------------------

variable "farm_rollup_enabled" {
  description = "Create the farm rollup: Cloud Run Job nextera-farm-rollup (incremental 30-minute farm rollups for the web app's farm History tab) + a Cloud Scheduler trigger (farm_rollup_schedule). On by default: without it the History tab has no data."
  type        = bool
  default     = true
}

variable "farm_rollup_paused" {
  description = "Pause the farm rollup's Cloud Scheduler trigger (keeps the job; the History tab stops updating). Only used when farm_rollup_enabled."
  type        = bool
  default     = false
}

variable "farm_rollup_schedule" {
  description = "Cron schedule (UTC) of the farm rollup. Default every 15 minutes (the web app says \"Daily figures refresh every 15 minutes\")."
  type        = string
  default     = "*/15 * * * *"

  validation {
    condition     = length(split(" ", trimspace(var.farm_rollup_schedule))) == 5
    error_message = "farm_rollup_schedule must be a five-field cron expression such as \"*/15 * * * *\"."
  }
}

# --- Monitoring (monitoring.tf) ----------------------------------------------------

variable "alert_emails" {
  description = "Email addresses that get every alert (one Cloud Monitoring email channel each; no verification needed). Empty = the alert policies still exist and open incidents in the console, but notify nobody."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for email in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", email))])
    error_message = "Every alert_emails entry must be an email address such as \"ops@example.com\"."
  }
}

variable "billing_account" {
  description = "Billing account ID (\"XXXXXX-XXXXXX-XXXXXX\") for an optional monthly budget on this project. Empty = no budget. Applying it needs roles/billing.costsManager on the billing account."
  type        = string
  default     = ""

  validation {
    condition     = var.billing_account == "" || can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "billing_account must be empty or a billing account ID like \"012345-6789AB-CDEF01\"."
  }
}

variable "monthly_budget" {
  description = "Monthly budget in whole units of the billing account's currency; alerts at 50% and 90% of actual and 100% of forecast spend. Required (> 0) when billing_account is set."
  type        = number
  default     = 0

  validation {
    condition     = var.monthly_budget >= 0 && floor(var.monthly_budget) == var.monthly_budget
    error_message = "monthly_budget must be a whole, non-negative number."
  }

  validation {
    condition     = var.billing_account == "" || var.monthly_budget > 0
    error_message = "Set monthly_budget (> 0) when billing_account is set."
  }
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

variable "github_repository_id" {
  description = "Numeric id of github_repository (`gh api repos/OWNER/REPO --jq .id`). If set, the WIF provider also requires it, so a re-created repository with the same name can't deploy. Empty: name check only."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.github_repository_id))
    error_message = "github_repository_id must be the numeric repository id (digits only), or empty."
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
