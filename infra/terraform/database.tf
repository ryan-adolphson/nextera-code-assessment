resource "google_sql_database_instance" "main" {
  name                = "nextera-pg"
  region              = var.region
  database_version    = var.db_version
  deletion_protection = var.deletion_protection

  settings {
    edition           = "ENTERPRISE"
    tier              = var.db_tier
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true

    # Public IP with NO authorized networks: only IAM-authorized Cloud SQL connectors
    # (Cloud Run's built-in connection, Cloud SQL Auth Proxy) can connect, always over TLS.
    ip_configuration {
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }

  depends_on = [google_project_service.this]
}

resource "google_sql_database" "app" {
  name     = "nextera"
  instance = google_sql_database_instance.main.name
}

resource "random_password" "db" {
  length  = 32
  special = false # keeps DATABASE_URL free of characters that need URL-encoding
}

resource "google_sql_user" "app" {
  name     = "nextera"
  instance = google_sql_database_instance.main.name
  password = random_password.db.result
}
