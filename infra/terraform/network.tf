# VPC used by Cloud Run Direct VPC egress (API and ingestion worker) to reach Memorystore (private IP only).
# Cloud SQL is reached through Cloud Run's built-in Cloud SQL connection instead (IAM + TLS, no VPC needed).
resource "google_compute_network" "main" {
  name                    = "nextera"
  auto_create_subnetworks = false

  depends_on = [google_project_service.this]
}

resource "google_compute_subnetwork" "run" {
  name                     = "nextera-run"
  network                  = google_compute_network.main.id
  region                   = var.region
  ip_cidr_range            = "10.10.0.0/24" # Direct VPC egress needs at least a /26
  private_ip_google_access = true
}
