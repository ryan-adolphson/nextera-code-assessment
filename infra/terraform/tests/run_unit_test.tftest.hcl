# Unit tests for the Cloud Run, Pub/Sub, WIF and Redis settings (run.tf, pubsub.tf, github.tf,
# redis.tf). Offline: every provider is mocked and every run is a plan, so no credentials are needed
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

run "defaults" {
  command = plan

  assert {
    condition = (
      tonumber(trimsuffix(google_cloud_run_v2_service.ingestion.template[0].timeout, "s"))
      < google_pubsub_subscription.telemetry_ingestion.ack_deadline_seconds
    )
    error_message = "The ingestion request timeout must be below the push subscription's ack deadline, or Pub/Sub redelivers running pushes."
  }

  assert {
    condition     = google_pubsub_subscription.telemetry_ingestion.ack_deadline_seconds == 90
    error_message = "The push subscription's ack deadline should be 90 s."
  }

  assert {
    condition = alltrue([
      for svc in [google_cloud_run_v2_service.api, google_cloud_run_v2_service.web] :
      alltrue([for probe in svc.template[0].containers[0].liveness_probe : probe.timeout_seconds >= 5 && probe.failure_threshold >= 3])
      && length(svc.template[0].containers[0].liveness_probe) == 1
    ])
    error_message = "The API and web liveness probes should have timeout_seconds >= 5 and failure_threshold >= 3."
  }

  assert {
    condition = alltrue([
      for svc in [google_cloud_run_v2_service.api, google_cloud_run_v2_service.ingestion, google_cloud_run_v2_service.web] :
      alltrue([for probe in svc.template[0].containers[0].liveness_probe : probe.timeout_seconds >= 5])
    ])
    error_message = "Every liveness probe should have timeout_seconds >= 5."
  }

  assert {
    condition     = google_cloud_run_v2_service.api.template[0].session_affinity != true
    error_message = "session_affinity does nothing for cross-origin requests without credentials; keep it off."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository == \"example-org/nextera\""
    error_message = "Without github_repository_id the WIF condition should check the repository name only (unchanged for existing tfvars)."
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.repository_id"] == "assertion.repository_id"
    error_message = "The WIF provider should map attribute.repository_id."
  }

  assert {
    condition     = google_redis_instance.events.maintenance_policy[0].weekly_maintenance_window[0].day == "SUNDAY"
    error_message = "Redis should have a weekly maintenance window on Sunday."
  }

  assert {
    condition     = google_redis_instance.events.maintenance_policy[0].weekly_maintenance_window[0].start_time[0].hours == 4
    error_message = "The Redis maintenance window should start at 04:00 UTC."
  }

  assert {
    condition     = google_project_service_identity.pubsub.service == "pubsub.googleapis.com"
    error_message = "The Pub/Sub service agent should be created explicitly."
  }

  assert {
    condition     = google_pubsub_topic_iam_member.dead_letter_publisher.member == "serviceAccount:service-123456789012@gcp-sa-pubsub.iam.gserviceaccount.com"
    error_message = "The Pub/Sub service agent member must stay the deterministic address, so existing bindings aren't replaced."
  }

  assert {
    condition     = contains(keys(google_project_service.this), "cloudresourcemanager.googleapis.com")
    error_message = "cloudresourcemanager.googleapis.com should be enabled (project IAM on a fresh project)."
  }
}

run "repository_id_is_added_to_the_wif_condition" {
  command = plan

  variables {
    github_repository_id = "123456789"
  }

  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository == \"example-org/nextera\" && assertion.repository_id == \"123456789\""
    error_message = "With github_repository_id the WIF condition should require both the name and the id."
  }
}

run "invalid_repository_id_fails" {
  command = plan

  variables {
    github_repository_id = "example-org/nextera"
  }

  expect_failures = [var.github_repository_id]
}
