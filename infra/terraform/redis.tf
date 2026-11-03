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

  # Updates (BASIC tier: a short outage, then an empty cache) happen in this window, not at random.
  # SSE replay history is lost on a BASIC restart either way; clients reload over REST.
  maintenance_policy {
    weekly_maintenance_window {
      day = "SUNDAY"
      start_time {
        hours = 4 # UTC
      }
    }
  }

  # Deliberately skipped, because each one recreates the instance (new IP, empty cache, new AUTH
  # string -> redis-url secret): STANDARD_HA tier, transit_encryption_mode = SERVER_AUTHENTICATION,
  # connect_mode = PRIVATE_SERVICE_ACCESS instead of DIRECT_PEERING, and a fixed reserved_ip_range
  # instead of the automatic one. Pick them before the first apply of a new environment.

  depends_on = [google_project_service.this]
}
