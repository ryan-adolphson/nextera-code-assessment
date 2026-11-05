# Unit tests for partition-maintenance.tf, live-summary.tf and anomaly-rollup.tf (+ their deployer
# IAM in github.tf, outputs.tf and the job failure policy in monitoring.tf). Offline: every provider
# is mocked and every run is a plan, so no credentials are needed and nothing is created. Run from
# infra/terraform:  terraform init -backend=false && terraform test

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

run "enabled_by_default_creates_three_jobs" {
  command = plan

  assert {
    condition = (
      google_cloud_run_v2_job.partition_maintenance[0].name == "nextera-partition-maintenance"
      && google_cloud_run_v2_job.live_summary[0].name == "nextera-live-summary"
      && google_cloud_run_v2_job.anomaly_rollup[0].name == "nextera-anomaly-rollup"
    )
    error_message = "All three jobs must exist by default, under the names deploy.yml updates."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.partition_maintenance[0].template[0].template[0].containers[0].args == tolist(["dist/partition-maintenance/main.js"])
      && google_cloud_run_v2_job.live_summary[0].template[0].template[0].containers[0].args == tolist(["dist/live-summary/main.js"])
      && google_cloud_run_v2_job.anomaly_rollup[0].template[0].template[0].containers[0].args == tolist(["dist/anomaly-rollup/main.js"])
      && google_cloud_run_v2_job.live_summary[0].template[0].template[0].containers[0].command == tolist(["node"])
      && google_cloud_run_v2_job.live_summary[0].template[0].template[0].containers[0].image == var.ingestion_image
    )
    error_message = "Each job must run its script with node in the ingestion image."
  }

  assert {
    condition = alltrue([
      for job in [google_cloud_run_v2_job.partition_maintenance[0], google_cloud_run_v2_job.live_summary[0], google_cloud_run_v2_job.anomaly_rollup[0]] :
      job.template[0].task_count == 1 && job.template[0].parallelism == 1
    ])
    error_message = "Each execution must be one task, one at a time."
  }

  assert {
    condition = (
      google_cloud_run_v2_job.live_summary[0].template[0].template[0].timeout == "50s"
      && google_cloud_run_v2_job.live_summary[0].template[0].template[0].max_retries == 0
      && google_cloud_run_v2_job.anomaly_rollup[0].template[0].template[0].timeout == "900s"
      && google_cloud_run_v2_job.partition_maintenance[0].template[0].template[0].timeout == "600s"
    )
    error_message = "The live summary must time out inside its 1-minute period without retries; the anomaly rollup gets 15 min."
  }

  assert {
    condition = (
      contains([for e in google_cloud_run_v2_job.partition_maintenance[0].template[0].template[0].containers[0].env : e.name], "DATABASE_URL")
      && contains([for e in google_cloud_run_v2_job.partition_maintenance[0].template[0].template[0].containers[0].env : e.value if e.name == "TELEMETRY_RETENTION_DAYS"], "31")
      && !contains([for e in google_cloud_run_v2_job.anomaly_rollup[0].template[0].template[0].containers[0].env : e.name], "REDIS_URL")
      && contains([for e in google_cloud_run_v2_job.live_summary[0].template[0].template[0].containers[0].env : e.name], "REDIS_URL")
      && contains([for e in google_cloud_run_v2_job.live_summary[0].template[0].template[0].containers[0].env : e.name], "DATABASE_URL")
    )
    error_message = "Partition maintenance needs DATABASE_URL + TELEMETRY_RETENTION_DAYS=31, live summary DATABASE_URL + REDIS_URL, anomaly rollup DATABASE_URL only."
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.live_summary[0].template[0].template[0].vpc_access) == 1
      && length(google_cloud_run_v2_job.partition_maintenance[0].template[0].template[0].vpc_access) == 0
      && length(google_cloud_run_v2_job.anomaly_rollup[0].template[0].template[0].vpc_access) == 0
    )
    error_message = "Only the live summary needs Direct VPC egress (Redis)."
  }

  assert {
    condition = (
      google_secret_manager_secret_iam_member.live_summary_redis_url[0].role == "roles/secretmanager.secretAccessor"
      && google_service_account.partition_maintenance_scheduler[0].account_id == "nextera-partition-maint-sched"
      && google_service_account.live_summary_scheduler[0].account_id == "nextera-live-summary-sched"
      && google_service_account.anomaly_rollup_scheduler[0].account_id == "nextera-anomaly-rollup-sched"
      && google_cloud_run_v2_job_iam_member.live_summary_scheduler_invoker[0].name == "nextera-live-summary"
      && google_cloud_run_v2_job_iam_member.partition_maintenance_scheduler_invoker[0].name == "nextera-partition-maintenance"
      && google_cloud_run_v2_job_iam_member.anomaly_rollup_scheduler_invoker[0].name == "nextera-anomaly-rollup"
    )
    error_message = "Each job has its own scheduler SA with run.invoker on that job only; the live summary SA reads redis-url."
  }

  assert {
    condition = (
      google_cloud_scheduler_job.partition_maintenance[0].schedule == "17 3 * * *"
      && google_cloud_scheduler_job.live_summary[0].schedule == "* * * * *"
      && google_cloud_scheduler_job.anomaly_rollup[0].schedule == "7 * * * *"
      && !google_cloud_scheduler_job.partition_maintenance[0].paused
      && !google_cloud_scheduler_job.live_summary[0].paused
      && !google_cloud_scheduler_job.anomaly_rollup[0].paused
    )
    error_message = "Default schedules: daily 03:17, every minute, hourly at :07, all unpaused."
  }

  assert {
    condition = (
      output.github_actions_variables["PARTITION_MAINTENANCE_JOB"] == "nextera-partition-maintenance"
      && output.github_actions_variables["LIVE_SUMMARY_JOB"] == "nextera-live-summary"
      && output.github_actions_variables["ANOMALY_ROLLUP_JOB"] == "nextera-anomaly-rollup"
      && output.partition_maintenance_job == "nextera-partition-maintenance"
    )
    error_message = "The job variables must be emitted for deploy.yml."
  }

  assert {
    condition = (
      toset(keys(google_cloud_run_v2_job_iam_member.deployer_developer)) == toset(["farm_rollup", "partition_maintenance", "live_summary", "anomaly_rollup"])
      && toset(keys(google_service_account_iam_member.deployer_act_as)) == toset(["api", "ingestion", "web", "farm_rollup", "partition_maintenance", "live_summary", "anomaly_rollup"])
    )
    error_message = "The deployer must update the three jobs and act as their SAs."
  }

  assert {
    condition = alltrue([
      for name in ["nextera-partition-maintenance", "nextera-live-summary", "nextera-anomaly-rollup"] :
      strcontains(google_monitoring_alert_policy.job_failures[0].conditions[0].condition_threshold[0].filter, "\"${name}\"")
    ])
    error_message = "The job failure policy must cover the three jobs."
  }

  assert {
    condition     = strcontains(google_monitoring_alert_policy.job_failures[0].documentation[0].content, "DEFAULT partition")
    error_message = "The failure runbook must explain what a failing partition maintenance means."
  }
}

run "disabled_creates_nothing" {
  command = plan

  variables {
    partition_maintenance_enabled = false
    live_summary_enabled          = false
    anomaly_rollup_enabled        = false
  }

  assert {
    condition = (
      length(google_cloud_run_v2_job.partition_maintenance) == 0
      && length(google_cloud_run_v2_job.live_summary) == 0
      && length(google_cloud_run_v2_job.anomaly_rollup) == 0
      && length(google_cloud_scheduler_job.partition_maintenance) == 0
      && length(google_cloud_scheduler_job.live_summary) == 0
      && length(google_cloud_scheduler_job.anomaly_rollup) == 0
      && length(google_service_account.partition_maintenance) == 0
      && length(google_service_account.live_summary) == 0
      && length(google_service_account.anomaly_rollup) == 0
      && length(google_service_account.live_summary_scheduler) == 0
      && length(google_secret_manager_secret_iam_member.live_summary_redis_url) == 0
    )
    error_message = "Disabling a job must remove all of its resources."
  }

  assert {
    condition = (
      !contains(keys(output.github_actions_variables), "PARTITION_MAINTENANCE_JOB")
      && !contains(keys(output.github_actions_variables), "LIVE_SUMMARY_JOB")
      && !contains(keys(output.github_actions_variables), "ANOMALY_ROLLUP_JOB")
      && output.live_summary_job == null
      && toset(keys(google_cloud_run_v2_job_iam_member.deployer_developer)) == toset(["farm_rollup"])
      && toset(keys(google_service_account_iam_member.deployer_act_as)) == toset(["api", "ingestion", "web", "farm_rollup"])
    )
    error_message = "A disabled job gets no repository variable and no deployer permissions."
  }
}

run "paused_custom_schedule_and_retention" {
  command = plan

  variables {
    partition_maintenance_paused   = true
    partition_maintenance_schedule = "42 2 * * *"
    live_summary_schedule          = "*/5 * * * *"
    telemetry_retention_days       = 14
  }

  assert {
    condition = (
      google_cloud_scheduler_job.partition_maintenance[0].paused
      && google_cloud_scheduler_job.partition_maintenance[0].schedule == "42 2 * * *"
      && google_cloud_scheduler_job.live_summary[0].schedule == "*/5 * * * *"
      && contains([for e in google_cloud_run_v2_job.partition_maintenance[0].template[0].template[0].containers[0].env : e.value if e.name == "TELEMETRY_RETENTION_DAYS"], "14")
    )
    error_message = "Paused, schedules and the retention must be honoured, and the job kept."
  }
}

run "only_scale_jobs_enable_cloud_scheduler" {
  command = plan

  variables {
    farm_rollup_enabled = false
  }

  assert {
    condition     = contains(keys(google_project_service.this), "cloudscheduler.googleapis.com")
    error_message = "The scale jobs need the Cloud Scheduler API."
  }
}

run "invalid_values_fail" {
  command = plan

  variables {
    live_summary_schedule          = "every minute"
    partition_maintenance_schedule = "daily"
    anomaly_rollup_schedule        = "hourly"
    telemetry_retention_days       = 0
  }

  expect_failures = [
    var.live_summary_schedule,
    var.partition_maintenance_schedule,
    var.anomaly_rollup_schedule,
    var.telemetry_retention_days,
  ]
}
