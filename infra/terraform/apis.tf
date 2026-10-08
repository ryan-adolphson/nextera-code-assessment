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
  # Only when the demo feed is on (demo-feed.tf): Cloud Scheduler triggers its Cloud Run Job.
  optional_services = var.demo_feed_enabled ? ["cloudscheduler.googleapis.com"] : []
}

resource "google_project_service" "this" {
  for_each = toset(concat(local.services, local.optional_services))

  service            = each.value
  disable_on_destroy = false
}
