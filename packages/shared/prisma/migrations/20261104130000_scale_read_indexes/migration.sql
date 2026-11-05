-- Scale to a million turbines, part 3: indexes for the keyset-paged reads (GET /api/turbines,
-- GET /api/alerts). Purely additive for the previous revision (indexes only; the replaced ones
-- were prefixes of the new ones, so no query loses its index).

-- A farm's turbines in id order, and the fleet sorted by farm; replaces the farm_id-only index.
CREATE INDEX "turbines_farm_id_turbine_id_idx" ON "turbines"("farm_id", "turbine_id");
DROP INDEX "turbines_farm_id_idx";

-- The commissioned filter and sort.
CREATE INDEX "turbines_commissioned_turbine_id_idx" ON "turbines"("commissioned", "turbine_id");

-- Last-seen sorting with the id as tie-break (most turbines share a reading time); replaces the
-- timestamp-only index, so ingestion's updates still maintain one timestamp index.
CREATE INDEX "turbine_latest_timestamp_turbine_id_idx" ON "turbine_latest"("timestamp", "turbine_id");
DROP INDEX "turbine_latest_timestamp_idx";

-- Flagged readings newest first (read by a backward scan; on the partitioned table: every partition gets the index, and
-- partitions created later inherit it through LIKE ... INCLUDING INDEXES).
CREATE INDEX "telemetry_alerts_reading_timestamp_telemetry_id_idx" ON "telemetry_alerts"("reading_timestamp", "telemetry_id");
