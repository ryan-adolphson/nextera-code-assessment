-- Drops alert_history (added in 20261007010000_alert_history): nothing ever wrote to it, and
-- telemetry_alerts now records which rules each reading triggered. Its foreign keys go with it.
-- Backward-compatible: the running revision never reads or writes the table.
-- DropTable
DROP TABLE "alert_history";
