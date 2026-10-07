-- telemetry.created_at: when the row was inserted (received_at can come from the payload or CSV for
-- backfills). Backward-compatible and fast: since PostgreSQL 11 adding a column with a non-volatile
-- default (now() is stable) is a metadata-only change, no table rewrite; the running revision's
-- inserts get the default. Existing rows get the time this migration runs.
-- AlterTable
ALTER TABLE "telemetry" ADD COLUMN     "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
