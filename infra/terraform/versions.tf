terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State lives in a GCS bucket you create once:
  #   terraform init -backend-config="bucket=<state-bucket>" -backend-config="prefix=nextera/prod"
  backend "gcs" {}
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Only for google_billing_budget (monitoring.tf): with user credentials the Billing Budgets API needs a
# quota project, so its calls are billed to this project (needs serviceusage.services.use on it).
# Every other resource keeps the default provider above.
provider "google" {
  alias                 = "billing_budget"
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

data "google_project" "this" {
  project_id = var.project_id
}
