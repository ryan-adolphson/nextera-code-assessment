# SSE event history + fan-out: the API and the ingestion worker publish; every API instance
# subscribes, so an event published anywhere reaches clients connected to any API instance.
resource "google_redis_instance" "events" {
  name               = "nextera-events"
  region             = var.region
  tier               = "BASIC"
  memory_size_gb     = 1
  redis_version      = "REDIS_7_2"
  authorized_network = google_compute_network.main.id
  connect_mode       = "DIRECT_PEERING"
  auth_enabled       = true

  depends_on = [google_project_service.this]
}
