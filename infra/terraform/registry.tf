resource "google_artifact_registry_repository" "images" {
  location      = var.region
  repository_id = "nextera"
  format        = "DOCKER"
  description   = "nextera api / ingestion / web images"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 20
    }
  }

  depends_on = [google_project_service.this]
}
