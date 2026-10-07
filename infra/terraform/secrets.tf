locals {
  # Unix socket provided by Cloud Run's Cloud SQL volume (mounted at /cloudsql).
  database_url = format(
    "postgresql://%s:%s@localhost/%s?host=/cloudsql/%s&schema=public",
    google_sql_user.app.name,
    random_password.db.result,
    google_sql_database.app.name,
    google_sql_database_instance.main.connection_name,
  )

  redis_url = format(
    "redis://:%s@%s:%d",
    google_redis_instance.events.auth_string,
    google_redis_instance.events.host,
    google_redis_instance.events.port,
  )

  secrets = {
    "database-url" = local.database_url
    "redis-url"    = local.redis_url
  }
}

resource "google_secret_manager_secret" "app" {
  for_each = local.secrets

  secret_id = each.key
  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}

resource "google_secret_manager_secret_version" "app" {
  for_each = local.secrets

  secret      = google_secret_manager_secret.app[each.key].id
  secret_data = each.value
}

# JWT signing key of the API (HS256). Terraform creates the secret but never its value, so the key
# stays out of Terraform state. Add it once before the API references it (CLAUDE.md, "Auth secrets"):
#   printf %s "$(openssl rand -base64 48)" | gcloud secrets versions add jwt-secret --data-file=-
# Rotating it (a new version) signs everyone out once the API restarts on the new version.
resource "google_secret_manager_secret" "jwt" {
  secret_id = "jwt-secret"
  replication {
    auto {}
  }

  depends_on = [google_project_service.this]
}
