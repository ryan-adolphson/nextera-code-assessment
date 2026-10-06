locals {
  services = [
    "artifactregistry.googleapis.com",
    "compute.googleapis.com", # VPC for Direct VPC egress
    "iam.googleapis.com",
    "iamcredentials.googleapis.com", # GitHub Actions: service account impersonation via WIF
    "pubsub.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "sqladmin.googleapis.com",
    "sts.googleapis.com", # GitHub Actions: Workload Identity Federation token exchange
  ]
}

resource "google_project_service" "this" {
  for_each = toset(local.services)

  service            = each.value
  disable_on_destroy = false
}
