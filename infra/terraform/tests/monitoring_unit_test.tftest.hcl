# Unit tests for monitoring.tf. Offline: every provider is mocked and every run is a plan, so no
# credentials are needed and nothing is created. Run from infra/terraform:
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

run "defaults_create_policies_without_channels_or_budget" {
  command = plan

  assert {
    condition     = length(google_monitoring_notification_channel.email) == 0
    error_message = "No alert_emails should mean no email notification channels."
  }

  assert {
    condition     = length(google_billing_budget.monthly) == 0
    error_message = "No billing_account should mean no budget."
  }

  assert {
    condition     = !contains(keys(google_project_service.this), "billingbudgets.googleapis.com")
    error_message = "billingbudgets.googleapis.com should only be enabled with a billing_account."
  }

  assert {
    condition     = contains(keys(google_project_service.this), "monitoring.googleapis.com")
    error_message = "monitoring.googleapis.com should always be enabled."
  }

  assert {
    condition     = toset(keys(google_monitoring_uptime_check_config.service)) == toset(["api", "web"])
    error_message = "There should be uptime checks for nextera-api and nextera-web only (ingestion is IAM-only)."
  }

  assert {
    condition     = google_monitoring_uptime_check_config.service["api"].http_check[0].path == "/api/health/ready"
    error_message = "The API uptime check should probe /api/health/ready."
  }

  assert {
    condition     = toset(keys(google_monitoring_alert_policy.uptime)) == toset(["api", "web"])
    error_message = "Every uptime check should have its own alert policy."
  }

  assert {
    condition = alltrue([
      google_monitoring_alert_policy.dead_letters.display_name != "",
      google_monitoring_alert_policy.ingestion_backlog.display_name != "",
      google_monitoring_alert_policy.cloud_run_errors.display_name != "",
      google_monitoring_alert_policy.cloud_sql.display_name != "",
      google_monitoring_alert_policy.redis_memory.display_name != "",
    ])
    error_message = "Every alert policy should exist without alert_emails."
  }

  assert {
    condition     = length(google_monitoring_alert_policy.dead_letters.notification_channels) == 0
    error_message = "Without alert_emails the policies should have no notification channels."
  }

  assert {
    condition     = strcontains(google_monitoring_alert_policy.dead_letters.conditions[0].condition_threshold[0].filter, "subscription_id = \"telemetry-dead-letter\"")
    error_message = "The dead-letter policy should watch the telemetry-dead-letter subscription."
  }

  assert {
    condition     = google_monitoring_alert_policy.ingestion_backlog.conditions[0].condition_threshold[0].threshold_value == 900
    error_message = "The ingestion backlog threshold should be 900 s."
  }

  assert {
    condition     = google_monitoring_alert_policy.cloud_run_errors.conditions[0].condition_threshold[0].denominator_filter != null
    error_message = "The 5xx policy should be a ratio (denominator_filter)."
  }

  assert {
    condition     = google_monitoring_alert_policy.cloud_run_errors.conditions[0].condition_threshold[0].aggregations[0].group_by_fields == tolist(["resource.label.service_name"])
    error_message = "The 5xx ratio should be grouped by service_name."
  }

  # (api_max_instances 5 + ingestion_max_instances 5) x db_pool_max 4 = 40 connections; 80% = 32.
  assert {
    condition     = google_monitoring_alert_policy.cloud_sql.conditions[1].condition_threshold[0].threshold_value == 32
    error_message = "The Cloud SQL connection threshold should be 80% of the default 40-connection budget."
  }
}

run "connection_threshold_follows_sizing_variables" {
  command = plan

  variables {
    api_max_instances       = 10
    ingestion_max_instances = 10
    db_pool_max             = 5
  }

  # (10 + 10) x 5 = 100 connections; 80% = 80.
  assert {
    condition     = google_monitoring_alert_policy.cloud_sql.conditions[1].condition_threshold[0].threshold_value == 80
    error_message = "The Cloud SQL connection threshold should follow the instance caps and db_pool_max."
  }
}

run "one_email_is_attached_to_every_policy" {
  command = plan

  variables {
    alert_emails = ["ops@example.com"]
  }

  assert {
    condition     = length(google_monitoring_notification_channel.email) == 1
    error_message = "One alert_emails entry should create one channel."
  }

  assert {
    condition     = google_monitoring_notification_channel.email["ops@example.com"].type == "email"
    error_message = "The channel should be an email channel."
  }

  assert {
    condition     = google_monitoring_notification_channel.email["ops@example.com"].labels.email_address == "ops@example.com"
    error_message = "The channel should send to the configured address."
  }

  assert {
    condition = alltrue([
      for policy in concat(
        [
          google_monitoring_alert_policy.dead_letters,
          google_monitoring_alert_policy.ingestion_backlog,
          google_monitoring_alert_policy.cloud_run_errors,
          google_monitoring_alert_policy.cloud_sql,
          google_monitoring_alert_policy.redis_memory,
        ],
        values(google_monitoring_alert_policy.uptime),
      ) : length(policy.notification_channels) == 1
    ])
    error_message = "Every alert policy should notify the email channel."
  }
}

run "budget_with_billing_account" {
  command = plan

  variables {
    alert_emails    = ["ops@example.com"]
    billing_account = "012345-6789AB-CDEF01"
    monthly_budget  = 200
  }

  assert {
    condition     = length(google_billing_budget.monthly) == 1
    error_message = "A billing_account should create the budget."
  }

  assert {
    condition     = google_billing_budget.monthly[0].budget_filter[0].projects == toset(["projects/123456789012"])
    error_message = "The budget should be scoped to this project by number."
  }

  assert {
    condition     = google_billing_budget.monthly[0].amount[0].specified_amount[0].units == "200"
    error_message = "The budget amount should be monthly_budget."
  }

  assert {
    condition     = length(google_billing_budget.monthly[0].all_updates_rule[0].monitoring_notification_channels) == 1
    error_message = "The budget should notify the email channel."
  }

  assert {
    condition     = contains(keys(google_project_service.this), "billingbudgets.googleapis.com")
    error_message = "A billing_account should enable billingbudgets.googleapis.com."
  }
}

run "billing_account_without_budget_fails" {
  command = plan

  variables {
    billing_account = "012345-6789AB-CDEF01"
  }

  expect_failures = [var.monthly_budget]
}

run "invalid_email_fails" {
  command = plan

  variables {
    alert_emails = ["not-an-email"]
  }

  expect_failures = [var.alert_emails]
}
