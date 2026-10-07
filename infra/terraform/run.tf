locals {
  sql_connection = google_sql_database_instance.main.connection_name

  # Browser origins of the Angular app, allowed by the API's CORS policy (CORS_ORIGINS).
  # The web service's run.app URL is computed, not read from google_cloud_run_v2_service.web: the web
  # service needs the API URL (API_BASE_URL) and the API needs the web origin, so referencing both
  # resources would be a dependency cycle. Cloud Run's deterministic URL
  # https://<service>-<project number>.<region>.run.app is known before either service exists.
  web_service_name = "nextera-web"
  web_run_url      = "https://${local.web_service_name}-${data.google_project.this.number}.${var.region}.run.app"
  web_origins      = concat([local.web_run_url], var.web_domain == "" ? [] : ["https://${var.web_domain}"])
  web_url          = var.web_domain == "" ? local.web_run_url : "https://${var.web_domain}"

  # Settings shared by the API and the ingestion worker.
  vpc_network_interface = {
    network    = google_compute_network.main.id
    subnetwork = google_compute_subnetwork.run.id
  }
  secret_env = {
    DATABASE_URL = google_secret_manager_secret.app["database-url"].secret_id
    REDIS_URL    = google_secret_manager_secret.app["redis-url"].secret_id
  }
}

# --- API + SSE (NestJS) ------------------------------------------------------
# Public: the Angular app (nextera-web) calls it directly from the browser (CORS), at api_domain if set.
resource "google_cloud_run_v2_service" "api" {
  name                 = "nextera-api"
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true # public API; app-level auth is the API's job
  deletion_protection  = var.deletion_protection

  template {
    service_account                  = google_service_account.api.email
    timeout                          = "3600s" # max request duration: SSE streams are closed after 60 min and EventSource reconnects
    max_instance_request_concurrency = var.api_concurrency
    session_affinity                 = true

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    vpc_access {
      network_interfaces {
        network    = local.vpc_network_interface.network
        subnetwork = local.vpc_network_interface.subnetwork
      }
      egress = "PRIVATE_RANGES_ONLY" # Memorystore via VPC, everything else direct
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.sql_connection]
      }
    }

    containers {
      image = var.api_image

      ports {
        container_port = 8080 # app must listen on process.env.PORT
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true # CPU billed only while requests (incl. open SSE streams) are active
        startup_cpu_boost = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "DB_POOL_MAX"
        value = tostring(var.db_pool_max)
      }
      env {
        name  = "CORS_ORIGINS"
        value = join(",", local.web_origins) # the web app's origins; see locals above
      }
      env {
        name  = "JWT_ISSUER"
        value = var.jwt_issuer
      }
      env {
        name  = "JWT_AUDIENCE"
        value = var.jwt_audience
      }
      # API only. The secret needs a version before this revision can start (CLAUDE.md, "Auth secrets").
      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt.secret_id
            version = "latest"
          }
        }
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      startup_probe {
        http_get {
          path = "/api/health/live"
        }
        period_seconds    = 5
        failure_threshold = 12
      }

      liveness_probe {
        http_get {
          path = "/api/health/live"
        }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    # CI deploys new images with `gcloud run deploy`; Terraform owns everything else.
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_project_iam_member.cloudsql_client,
    google_secret_manager_secret_iam_member.access,
    google_secret_manager_secret_iam_member.api_jwt,
    google_secret_manager_secret_version.app,
  ]
}

locals {
  # Public API base URL: the custom domain if set, else the run.app URL.
  api_url = var.api_domain == "" ? google_cloud_run_v2_service.api.uri : "https://${var.api_domain}"
}

# api.example.com -> nextera-api, with a Google-managed certificate. DNS records: see outputs.
resource "google_cloud_run_domain_mapping" "api" {
  count    = var.api_domain == "" ? 0 : 1
  location = var.region
  name     = var.api_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.api.name
  }
}

# --- Ingestion worker (NestJS, Pub/Sub push) -----------------------------------
# Private: requires IAM, and only the Pub/Sub push identity has roles/run.invoker (iam.tf).
resource "google_cloud_run_v2_service" "ingestion" {
  name                = "nextera-ingestion"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL" # reachable by Pub/Sub push; IAM still blocks everyone else
  deletion_protection = var.deletion_protection

  template {
    service_account                  = google_service_account.ingestion.email
    timeout                          = "60s" # below the subscription's ack deadline
    max_instance_request_concurrency = var.ingestion_concurrency

    scaling {
      min_instance_count = 0 # scales to zero between bursts
      max_instance_count = var.ingestion_max_instances
    }

    vpc_access {
      network_interfaces {
        network    = local.vpc_network_interface.network
        subnetwork = local.vpc_network_interface.subnetwork
      }
      egress = "PRIVATE_RANGES_ONLY"
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [local.sql_connection]
      }
    }

    containers {
      image = var.ingestion_image

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "DB_POOL_MAX"
        value = tostring(var.db_pool_max)
      }
      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      startup_probe {
        http_get {
          path = "/health/live"
        }
        period_seconds    = 5
        failure_threshold = 12
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [
    google_project_iam_member.cloudsql_client,
    google_secret_manager_secret_iam_member.access,
    google_secret_manager_secret_version.app,
  ]
}

# --- Angular app (nginx serving the production build) ------------------------------------------
# Public static site. The browser calls the API directly at local.api_url (CORS), never through
# this service: no proxying, so SSE streams don't count against the web service.
resource "google_cloud_run_v2_service" "web" {
  name                 = local.web_service_name
  location             = var.region
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true # public website
  deletion_protection  = var.deletion_protection

  template {
    service_account                  = google_service_account.web.email # no roles: serves files only
    timeout                          = "30s"
    max_instance_request_concurrency = 250 # nginx serving static files

    scaling {
      min_instance_count = 0 # cold starts are ~1s for nginx; set >= 1 if that matters
      max_instance_count = var.web_max_instances
    }

    containers {
      image = var.web_image

      ports {
        container_port = 8080 # nginx listens on $PORT (apps/web/docker/default.conf.template)
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
        cpu_idle = true
      }

      # Runtime config: the container validates it at startup (refuses https-less, placeholder or
      # non-"/api" URLs) and serves it as /config.json to the app. One image for every environment.
      env {
        name  = "API_BASE_URL"
        value = "${local.api_url}/api"
      }

      startup_probe {
        http_get {
          path = "/health/live"
        }
        period_seconds    = 2
        failure_threshold = 15
      }

      liveness_probe {
        http_get {
          path = "/health/live"
        }
        period_seconds = 30
      }
    }
  }

  lifecycle {
    # CI deploys new images with `gcloud run deploy`; Terraform owns everything else.
    ignore_changes = [template[0].containers[0].image, client, client_version]
  }

  depends_on = [google_project_service.this]
}

# app.example.com -> nextera-web, with a Google-managed certificate. DNS records: see outputs.
resource "google_cloud_run_domain_mapping" "web" {
  count    = var.web_domain == "" ? 0 : 1
  location = var.region
  name     = var.web_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.web.name
  }
}
