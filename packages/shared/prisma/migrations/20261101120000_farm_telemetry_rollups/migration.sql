-- Farm telemetry rollups: 30-minute buckets of each farm's series (power summed over the turbines
-- that reported, the other metrics averaged) with open/close/high/low per metric, written by the
-- farm rollup job (`node dist/farm-rollup/main.js`, `npm run rollup`). Daily candles are aggregated
-- from these rows on read (GET /api/farms/:farmId/telemetry/daily).
--
-- Expand-only and backward-compatible: three new tables, one index on telemetry and a trigger on
-- turbines that only inserts into the new farm_rollup_dirty table. The running revision never
-- reads the new tables, and its writes (including the Unallocated move) keep working.
--
-- * farm_rollup_state: the job's watermark on telemetry.created_at (one row).
-- * farm_rollup_dirty: farms to recompute from a time, for changes created_at can't show. A move
--   (UPDATE turbines SET farm_id) rewrites telemetry.farm_id through the composite FK's ON UPDATE
--   CASCADE without inserting rows, so the trigger below marks both farms from the turbine's first
--   reading, in the move's transaction, whoever runs it (the API, a seed, psql).
-- * telemetry_created_at_idx: the job's incremental scan (rows created since the watermark).
--   A plain CREATE INDEX briefly blocks telemetry writes while it builds (seconds at today's size).
--
-- Note: a TRUNCATE of farms must now include farm_telemetry_rollups (or CASCADE).

-- CreateTable
CREATE TABLE "farm_telemetry_rollups" (
    "farm_id" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ(3) NOT NULL,
    "readings" INTEGER NOT NULL,
    "turbines" INTEGER NOT NULL,
    "power_open" DOUBLE PRECISION NOT NULL,
    "power_close" DOUBLE PRECISION NOT NULL,
    "power_high" DOUBLE PRECISION NOT NULL,
    "power_low" DOUBLE PRECISION NOT NULL,
    "wind_speed_open" DOUBLE PRECISION NOT NULL,
    "wind_speed_close" DOUBLE PRECISION NOT NULL,
    "wind_speed_high" DOUBLE PRECISION NOT NULL,
    "wind_speed_low" DOUBLE PRECISION NOT NULL,
    "rotor_rpm_open" DOUBLE PRECISION NOT NULL,
    "rotor_rpm_close" DOUBLE PRECISION NOT NULL,
    "rotor_rpm_high" DOUBLE PRECISION NOT NULL,
    "rotor_rpm_low" DOUBLE PRECISION NOT NULL,
    "blade_pitch_open" DOUBLE PRECISION NOT NULL,
    "blade_pitch_close" DOUBLE PRECISION NOT NULL,
    "blade_pitch_high" DOUBLE PRECISION NOT NULL,
    "blade_pitch_low" DOUBLE PRECISION NOT NULL,
    "gearbox_temp_open" DOUBLE PRECISION NOT NULL,
    "gearbox_temp_close" DOUBLE PRECISION NOT NULL,
    "gearbox_temp_high" DOUBLE PRECISION NOT NULL,
    "gearbox_temp_low" DOUBLE PRECISION NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_telemetry_rollups_pkey" PRIMARY KEY ("farm_id","bucket_start")
);

-- CreateTable
CREATE TABLE "farm_rollup_state" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "watermark" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_rollup_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "farm_rollup_dirty" (
    "id" BIGSERIAL NOT NULL,
    "farm_id" TEXT NOT NULL,
    "from_time" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_rollup_dirty_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "telemetry_created_at_idx" ON "telemetry"("created_at");

-- AddForeignKey
ALTER TABLE "farm_telemetry_rollups" ADD CONSTRAINT "farm_telemetry_rollups_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Dirty markers for moves (hand-written: Prisma doesn't model triggers, so `migrate diff` ignores
-- it). AFTER UPDATE: the turbine's readings keep their timestamps, so min(timestamp) is the same
-- before and after the cascade.
CREATE FUNCTION "farm_rollup_mark_turbine_move"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  first_reading TIMESTAMPTZ(3);
BEGIN
  SELECT min("timestamp") INTO first_reading
  FROM "telemetry"
  WHERE "turbine_id" IN (OLD."turbine_id", NEW."turbine_id");
  IF first_reading IS NOT NULL THEN
    INSERT INTO "farm_rollup_dirty" ("farm_id", "from_time")
    VALUES (OLD."farm_id", first_reading), (NEW."farm_id", first_reading);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER "turbines_farm_rollup_dirty"
AFTER UPDATE OF "farm_id" ON "turbines"
FOR EACH ROW
WHEN (OLD."farm_id" IS DISTINCT FROM NEW."farm_id")
EXECUTE FUNCTION "farm_rollup_mark_turbine_move"();
