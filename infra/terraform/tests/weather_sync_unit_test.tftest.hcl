# Unit tests for weather-sync.tf (+ its deployer IAM in github.tf and the Cloud Scheduler API in
# apis.tf). Offline: every provider is mocked and every run is a plan, so no credentials are needed
# and nothing is created. Run from infra/terraform:
#   terraform init -backend=false && terraform test

mock_provider "google" {}

mock_provider "google" {
  alias = "billing_budget"
}

mock_provider "google-beta" {}

mock_provider "random" {}

override_data {
  target = data.google_project.this
  values = {
    number = "123456789012"
  }
}

variables {
  project_id        = "nextera-test"
  github_repository = "example-org/nextera"
}

run "disabled_by_default_creates_nothing" {
  command = plan

  variables {
    farm_rollup_enabled = false # on by default and also needs Cloud Scheduler (farm_rollup_unit_test)
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.weather_sync) == 0
      && length(google_service_account.weather_sync) == 0
      && length(google_service_account.weather_sync_scheduler) == 0
      && length(google_cloud_scheduler_job.weather_sync) == 0
      && length(google_project_iam_member.weather_sync_cloudsql_client) == 0
      && length(google_secret_manager_secret_iam_member.weather_sync_database_url) == 0
      && length(google_secret_manager_secret.open_meteo_api_key) == 0
    )
    error_message = "weather_sync_enabled = false (the default) must create no weather sync resources."
  }

  assert {
    condition     = !contains(keys(google_project_service.this), "cloudscheduler.googleapis.com")
    error_message = "Cloud Scheduler should only be enabled when a scheduled job (demo feed, weather sync, farm rollup) is on."
  }

  assert {
    condition     = !contains(keys(output.github_actions_variables), "WEATHER_SYNC_JOB")
    error_message = "WEATHER_SYNC_JOB must not be a repository variable while the weather sync is off."
  }

  assert {
    condition = (
      !contains(keys(google_cloud_run_v2_job_iam_member.deployer_developer), "weather_sync")
      && !contains(keys(google_service_account_iam_member.deployer_act_as), "weather_sync")
    )
    error_message = "The deployer must get no weather sync permissions while it is off."
  }
}

run "enabled_creates_job_identities_and_schedule" {
  command = plan

  variables {
    weather_sync_enabled = true
  }

  assert {
    condition     = google_cloud_run_v2_job.weather_sync[0].name == "nextera-weather-sync"
    error_message = "The job must be called nextera-weather-sync (deploy.yml updates it by that name)."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].command == tolist(["node"])
      && google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].args == tolist(["dist/weather-sync/main.js"])
      && google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].image == var.ingestion_image
    )
    error_message = "The job must run `node dist/weather-sync/main.js` in the ingestion image."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.weather_sync[0].template[0].template[0].timeout == "600s"
      && google_cloud_run_v2_job.weather_sync[0].template[0].template[0].max_retries == 1
      && google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].resources[0].limits["cpu"] == "1"
      && google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].resources[0].limits["memory"] == "512Mi"
    )
    error_message = "The job should have a 10 min timeout, 1 retry, 1 CPU and 512Mi."
  }

  assert {
    condition = (
      contains([for e in google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].env : e.name], "DATABASE_URL")
      && !contains([for e in google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].env : e.name], "OPEN_METEO_API_KEY")
      && !contains([for e in google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].env : e.name], "REDIS_URL")
    )
    error_message = "The job needs DATABASE_URL, and neither REDIS_URL nor OPEN_METEO_API_KEY without open_meteo_api_key_enabled."
  }

  assert {
    condition = (
      # The connection name is only known after apply; one instance on a volume named like the mount.
      length(google_cloud_run_v2_job.weather_sync[0].template[0].template[0].volumes[0].cloud_sql_instance[0].instances) == 1
      && google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].volume_mounts[0].name == google_cloud_run_v2_job.weather_sync[0].template[0].template[0].volumes[0].name
      && google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].volume_mounts[0].mount_path == "/cloudsql"
    )
    error_message = "The job must mount the Cloud SQL socket at /cloudsql, like nextera-ingestion (database-url uses it)."
  }

  assert {
    condition = (
      google_project_iam_member.weather_sync_cloudsql_client[0].role == "roles/cloudsql.client"
      && google_secret_manager_secret_iam_member.weather_sync_database_url[0].role == "roles/secretmanager.secretAccessor"
      && length(google_secret_manager_secret_iam_member.weather_sync_api_key) == 0
    )
    error_message = "The job's SA should get Cloud SQL client and the database-url secret only."
  }

  assert {
    condition = (
      google_cloud_run_v2_job_iam_member.weather_sync_scheduler_invoker[0].role == "roles/run.invoker"
      && google_cloud_run_v2_job_iam_member.weather_sync_scheduler_invoker[0].name == "nextera-weather-sync"
    )
    error_message = "The scheduler SA should be run.invoker on the weather sync job only."
  }

  assert {
    condition = (
      google_cloud_scheduler_job.weather_sync[0].schedule == "30 1 * * *"
      && google_cloud_scheduler_job.weather_sync[0].time_zone == "Etc/UTC"
      && google_cloud_scheduler_job.weather_sync[0].paused == false
      && endswith(google_cloud_scheduler_job.weather_sync[0].http_target[0].uri, "/jobs/nextera-weather-sync:run")
    )
    error_message = "The schedule should run the job daily at 01:30 UTC, unpaused, through the Cloud Run Admin API."
  }

  assert {
    condition     = contains(keys(google_project_service.this), "cloudscheduler.googleapis.com")
    error_message = "The weather sync needs the Cloud Scheduler API."
  }

  assert {
    condition     = output.github_actions_variables["WEATHER_SYNC_JOB"] == "nextera-weather-sync"
    error_message = "WEATHER_SYNC_JOB must be a repository variable when the weather sync is on."
  }

  assert {
    condition = (
      google_cloud_run_v2_job_iam_member.deployer_developer["weather_sync"].role == "roles/run.developer"
      && google_cloud_run_v2_job_iam_member.deployer_developer["weather_sync"].name == "nextera-weather-sync"
      && !contains(keys(google_cloud_run_v2_job_iam_member.deployer_developer), "demo_feed")
    )
    error_message = "The deployer should be run.developer on the weather sync job (and on no demo feed job while that is off)."
  }

  assert {
    condition     = google_service_account_iam_member.deployer_act_as["weather_sync"].role == "roles/iam.serviceAccountUser"
    error_message = "The deployer needs actAs on the weather sync SA to update the job."
  }
}

run "paused_and_custom_schedule" {
  command = plan

  variables {
    weather_sync_enabled  = true
    weather_sync_paused   = true
    weather_sync_schedule = "0 3 * * *"
  }

  assert {
    condition = (
      google_cloud_scheduler_job.weather_sync[0].paused == true
      && google_cloud_scheduler_job.weather_sync[0].schedule == "0 3 * * *"
      && length(google_cloud_run_v2_job.weather_sync) == 1
    )
    error_message = "weather_sync_paused should pause the schedule and keep the job."
  }
}

run "api_key_secret_is_mounted_when_enabled" {
  command = plan

  variables {
    weather_sync_enabled       = true
    open_meteo_api_key_enabled = true
  }

  assert {
    condition     = google_secret_manager_secret.open_meteo_api_key[0].secret_id == "open-meteo-api-key"
    error_message = "open_meteo_api_key_enabled should create the secret open-meteo-api-key."
  }

  assert {
    condition = (
      contains([for e in google_cloud_run_v2_job.weather_sync[0].template[0].template[0].containers[0].env : e.name], "OPEN_METEO_API_KEY")
      && google_secret_manager_secret_iam_member.weather_sync_api_key[0].role == "roles/secretmanager.secretAccessor"
    )
    error_message = "With the key enabled the job should get OPEN_METEO_API_KEY and its SA access to that secret."
  }
}

run "demo_feed_and_weather_sync_both_get_deployer_bindings" {
  command = plan

  variables {
    demo_feed_enabled    = true
    weather_sync_enabled = true
  }

  assert {
    condition = (
      toset(keys(google_cloud_run_v2_job_iam_member.deployer_developer)) == toset(["demo_feed", "weather_sync", "farm_rollup"])
      && contains(keys(google_service_account_iam_member.deployer_act_as), "demo_feed")
      && contains(keys(google_service_account_iam_member.deployer_act_as), "weather_sync")
    )
    error_message = "The deployer should be able to update every enabled job (the farm rollup is on by default)."
  }

  assert {
    condition = (
      contains(keys(output.github_actions_variables), "DEMO_FEED_JOB")
      && contains(keys(output.github_actions_variables), "WEATHER_SYNC_JOB")
    )
    error_message = "Both job variables should be in github_actions_variables."
  }
}

run "invalid_schedule_fails" {
  command = plan

  variables {
    weather_sync_schedule = "daily"
  }

  expect_failures = [var.weather_sync_schedule]
}
