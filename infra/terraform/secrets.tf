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
