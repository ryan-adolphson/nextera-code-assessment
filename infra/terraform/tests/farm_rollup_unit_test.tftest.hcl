# Unit tests for farm-rollup.tf (+ its deployer IAM in github.tf, the Cloud Scheduler API in apis.tf,
# its output and the job failure policy in monitoring.tf). Offline: every provider is mocked and every
# run is a plan, so no credentials are needed and nothing is created. Run from infra/terraform:
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
  # The scale jobs are on by default; their own test file covers them.
  partition_maintenance_enabled = false
  live_summary_enabled          = false
  anomaly_rollup_enabled        = false
  project_id                    = "nextera-test"
  github_repository             = "example-org/nextera"
}

run "enabled_by_default_creates_job_identities_and_schedule" {
  command = plan

  assert {
    condition     = google_cloud_run_v2_job.farm_rollup[0].name == "nextera-farm-rollup"
    error_message = "The farm rollup must exist by default (the History tab needs it) and be called nextera-farm-rollup (deploy.yml updates it by that name)."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].command == tolist(["node"])
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].args == tolist(["dist/farm-rollup/main.js"])
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].image == var.ingestion_image
    )
    error_message = "The job must run `node dist/farm-rollup/main.js` in the ingestion image."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].timeout == "300s"
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].max_retries == 1
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].resources[0].limits["cpu"] == "1"
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].resources[0].limits["memory"] == "512Mi"
    )
    error_message = "The job should have a 5 min timeout, 1 retry, 1 CPU and 512Mi."
  }

  assert {
    condition = (
      contains([for e in google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].env : e.name], "DATABASE_URL")
      && contains([
        for e in google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].env :
        e.value_source[0].secret_key_ref[0].secret if e.name == "DATABASE_URL"
      ], "database-url")
      && contains([
        for e in google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].env :
        e.value_source[0].secret_key_ref[0].secret if e.name == "REDIS_URL"
      ], "redis-url")
    )
    error_message = "The job needs DATABASE_URL from the database-url secret and REDIS_URL from the redis-url secret."
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].vpc_access) == 1
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].vpc_access[0].egress == "PRIVATE_RANGES_ONLY"
      && length(google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].vpc_access[0].network_interfaces) == 1
    )
    error_message = "The job needs Direct VPC egress (PRIVATE_RANGES_ONLY) to reach Memorystore; without it publishing fails silently."
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].volumes[0].cloud_sql_instance[0].instances) == 1
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].volume_mounts[0].name == google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].volumes[0].name
      && google_cloud_run_v2_job.farm_rollup[0].template[0].template[0].containers[0].volume_mounts[0].mount_path == "/cloudsql"
    )
    error_message = "The job must mount the Cloud SQL socket at /cloudsql, like nextera-ingestion (database-url uses it)."
  }

  assert {
    condition = (
      google_service_account.farm_rollup[0].account_id == "nextera-farm-rollup"
      && google_project_iam_member.farm_rollup_cloudsql_client[0].role == "roles/cloudsql.client"
      && google_secret_manager_secret_iam_member.farm_rollup_database_url[0].role == "roles/secretmanager.secretAccessor"
      && google_secret_manager_secret_iam_member.farm_rollup_redis_url[0].role == "roles/secretmanager.secretAccessor"
    )
    error_message = "The job's own SA should get Cloud SQL client and the database-url and redis-url secrets only."
  }

  assert {
    condition = (
      google_service_account.farm_rollup_scheduler[0].account_id == "nextera-farm-rollup-scheduler"
      && google_cloud_run_v2_job_iam_member.farm_rollup_scheduler_invoker[0].role == "roles/run.invoker"
      && google_cloud_run_v2_job_iam_member.farm_rollup_scheduler_invoker[0].name == "nextera-farm-rollup"
    )
    error_message = "Its own scheduler SA should be run.invoker on the farm rollup job only."
  }

  assert {
    condition = (
      google_cloud_scheduler_job.farm_rollup[0].schedule == "*/15 * * * *"
      && google_cloud_scheduler_job.farm_rollup[0].time_zone == "Etc/UTC"
      && google_cloud_scheduler_job.farm_rollup[0].paused == false
      && endswith(google_cloud_scheduler_job.farm_rollup[0].http_target[0].uri, "/jobs/nextera-farm-rollup:run")
    )
    error_message = "The schedule should run the job every 15 minutes (UTC), unpaused, through the Cloud Run Admin API."
  }

  assert {
    condition     = contains(keys(google_project_service.this), "cloudscheduler.googleapis.com")
    error_message = "The farm rollup (on by default) needs the Cloud Scheduler API."
  }

  assert {
    condition = (
      output.github_actions_variables["FARM_ROLLUP_JOB"] == "nextera-farm-rollup"
      && output.farm_rollup_job == "nextera-farm-rollup"
    )
    error_message = "FARM_ROLLUP_JOB must be a repository variable, and farm_rollup_job an output, when the farm rollup is on."
  }

  assert {
    condition = (
      toset(keys(google_cloud_run_v2_job_iam_member.deployer_developer)) == toset(["farm_rollup"])
      && google_cloud_run_v2_job_iam_member.deployer_developer["farm_rollup"].role == "roles/run.developer"
      && google_cloud_run_v2_job_iam_member.deployer_developer["farm_rollup"].name == "nextera-farm-rollup"
    )
    error_message = "By default the deployer should be run.developer on the farm rollup job only."
  }

  assert {
    condition     = google_service_account_iam_member.deployer_act_as["farm_rollup"].role == "roles/iam.serviceAccountUser"
    error_message = "The deployer needs actAs on the farm rollup SA to update the job."
  }

  assert {
    condition = (
      length(google_monitoring_alert_policy.job_failures) == 1
      && strcontains(google_monitoring_alert_policy.job_failures[0].conditions[0].condition_threshold[0].filter, "job_name = one_of(\"nextera-farm-rollup\")")
      && strcontains(google_monitoring_alert_policy.job_failures[0].conditions[0].condition_threshold[0].filter, "metric.label.result = \"failed\"")
      && strcontains(google_monitoring_alert_policy.job_failures[0].conditions[0].condition_threshold[0].filter, "run.googleapis.com/job/completed_execution_count")
    )
    error_message = "A failed farm rollup execution should open an incident."
  }
}

run "disabled_creates_nothing" {
  command = plan

  variables {
    farm_rollup_enabled = false
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.farm_rollup) == 0
      && length(google_service_account.farm_rollup) == 0
      && length(google_service_account.farm_rollup_scheduler) == 0
      && length(google_cloud_scheduler_job.farm_rollup) == 0
      && length(google_cloud_run_v2_job_iam_member.farm_rollup_scheduler_invoker) == 0
      && length(google_project_iam_member.farm_rollup_cloudsql_client) == 0
      && length(google_secret_manager_secret_iam_member.farm_rollup_database_url) == 0
      && length(google_secret_manager_secret_iam_member.farm_rollup_redis_url) == 0
    )
    error_message = "farm_rollup_enabled = false must create no farm rollup resources."
  }

  assert {
    condition     = !contains(keys(google_project_service.this), "cloudscheduler.googleapis.com")
    error_message = "With every scheduled job off, Cloud Scheduler should not be enabled."
  }

  assert {
    condition = (
      !contains(keys(output.github_actions_variables), "FARM_ROLLUP_JOB")
      && output.farm_rollup_job == null
    )
    error_message = "FARM_ROLLUP_JOB must not be a repository variable (and farm_rollup_job is null) while the farm rollup is off."
  }

  assert {
    condition = (
      !contains(keys(google_cloud_run_v2_job_iam_member.deployer_developer), "farm_rollup")
      && !contains(keys(google_service_account_iam_member.deployer_act_as), "farm_rollup")
    )
    error_message = "The deployer must get no farm rollup permissions while it is off."
  }

  assert {
    condition     = length(google_monitoring_alert_policy.job_failures) == 0
    error_message = "With no scheduled job there should be no job failure policy."
  }
}

run "paused_and_custom_schedule" {
  command = plan

  variables {
    farm_rollup_paused   = true
    farm_rollup_schedule = "*/30 * * * *"
  }

  assert {
    condition = (
      google_cloud_scheduler_job.farm_rollup[0].paused == true
      && google_cloud_scheduler_job.farm_rollup[0].schedule == "*/30 * * * *"
      && length(google_cloud_run_v2_job.farm_rollup) == 1
      && contains(keys(google_cloud_run_v2_job_iam_member.deployer_developer), "farm_rollup")
    )
    error_message = "farm_rollup_paused should pause the schedule and keep the job (still updated by deploys)."
  }
}

run "every_job_gets_deployer_bindings_and_failure_alerts" {
  command = plan

  variables {
    demo_feed_enabled    = true
    weather_sync_enabled = true
  }

  assert {
    condition = (
      toset(keys(google_cloud_run_v2_job_iam_member.deployer_developer)) == toset(["demo_feed", "weather_sync", "farm_rollup"])
      && toset(keys(google_service_account_iam_member.deployer_act_as)) == toset(["api", "ingestion", "web", "demo_feed", "weather_sync", "farm_rollup"])
    )
    error_message = "The deployer should be able to update all three jobs and act as each runtime SA."
  }

  assert {
    condition = alltrue([
      for key in ["DEMO_FEED_JOB", "WEATHER_SYNC_JOB", "FARM_ROLLUP_JOB"] : contains(keys(output.github_actions_variables), key)
    ])
    error_message = "Every enabled job's variable should be in github_actions_variables."
  }

  assert {
    condition = alltrue([
      for name in ["nextera-farm-rollup", "nextera-weather-sync", "nextera-demo-feed"] :
      strcontains(google_monitoring_alert_policy.job_failures[0].conditions[0].condition_threshold[0].filter, "\"${name}\"")
    ])
    error_message = "The job failure policy should cover every enabled job."
  }
}

run "invalid_schedule_fails" {
  command = plan

  variables {
    farm_rollup_schedule = "every 15 minutes"
  }

  expect_failures = [var.farm_rollup_schedule]
}
