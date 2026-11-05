-- Scale to a million turbines, part 1: partitioned telemetry, latest-reading and summary tables.
--
-- Hand-written, because Prisma can't model partitions (`migrate diff` sees one table and would
-- plan a DROP + CREATE). Backward-compatible with the previous revision, which keeps running
-- until the new services are live:
--   * telemetry and telemetry_alerts keep their names and columns (telemetry_alerts gains
--     reading_timestamp). Existing rows are NOT copied: the old tables become the DEFAULT
--     partitions (telemetry_default, telemetry_alerts_default) of the new partitioned tables.
--     Daily partitions are carved out of them by telemetry_ensure_partition() (below), which
--     moves the rows of a day into its partition. The partition-maintenance job keeps creating
--     the next days' partitions; rows older than the retention are dropped with their partition.
--   * The previous revision inserts telemetry_alerts (telemetry_id, alert_id) without
--     reading_timestamp. TEMPORARY: the column defaults to the epoch, so such a row is routed to
--     the DEFAULT partition, where the BEFORE INSERT trigger telemetry_alerts_fill_reading_timestamp
--     re-inserts it with the reading's timestamp (into the right daily partition) and drops the
--     placeholder. A later migration removes the default and the trigger once only the new
--     revision runs.
--   * turbine_latest is filled below from the existing readings. Readings the previous revision
--     writes during the rollout don't update it; each turbine's next reading (the new revision
--     upserts it in the same transaction) corrects it within one reporting interval.
--
-- The primary key of telemetry becomes (id, timestamp): Postgres requires the partition key in
-- every unique constraint. (turbine_id, timestamp) stays unique.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------------------------
-- telemetry → partitioned (the old table becomes its DEFAULT partition)

ALTER TABLE "telemetry_alerts" DROP CONSTRAINT "telemetry_alerts_telemetry_id_fkey";

ALTER TABLE "telemetry" DROP CONSTRAINT "telemetry_pkey";
ALTER TABLE "telemetry" RENAME TO "telemetry_default";
ALTER INDEX "telemetry_created_at_idx" RENAME TO "telemetry_default_created_at_idx";
ALTER INDEX "telemetry_farm_id_timestamp_idx" RENAME TO "telemetry_default_farm_id_timestamp_idx";
ALTER INDEX "telemetry_turbine_id_timestamp_key" RENAME TO "telemetry_default_turbine_id_timestamp_key";

CREATE TABLE "telemetry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "turbine_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "power_output_kw" DOUBLE PRECISION NOT NULL,
    "wind_speed_ms" DOUBLE PRECISION NOT NULL,
    "rotor_rpm" DOUBLE PRECISION NOT NULL,
    "blade_pitch_deg" DOUBLE PRECISION NOT NULL,
    "gearbox_temp_c" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "telemetry_pkey" PRIMARY KEY ("id", "timestamp")
) PARTITION BY RANGE ("timestamp");

CREATE UNIQUE INDEX "telemetry_turbine_id_timestamp_key" ON "telemetry"("turbine_id", "timestamp");
CREATE INDEX "telemetry_farm_id_timestamp_idx" ON "telemetry"("farm_id", "timestamp");
CREATE INDEX "telemetry_created_at_idx" ON "telemetry"("created_at");

ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_turbine_id_farm_id_fkey" FOREIGN KEY ("turbine_id", "farm_id") REFERENCES "turbines"("turbine_id", "farm_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Attaching builds (id, timestamp) on the old table and re-checks its rows against the foreign key.
ALTER TABLE "telemetry" ATTACH PARTITION "telemetry_default" DEFAULT;

-- ---------------------------------------------------------------------------------------------
-- telemetry_alerts → partitioned the same way, on reading_timestamp

ALTER TABLE "telemetry_alerts" ADD COLUMN "reading_timestamp" TIMESTAMPTZ(3);
UPDATE "telemetry_alerts" a
SET "reading_timestamp" = t."timestamp"
FROM "telemetry" t
WHERE t."id" = a."telemetry_id";
-- A link without its reading cannot exist (it was a foreign key), but never fail the migration.
DELETE FROM "telemetry_alerts" WHERE "reading_timestamp" IS NULL;
ALTER TABLE "telemetry_alerts" ALTER COLUMN "reading_timestamp" SET NOT NULL;

ALTER TABLE "telemetry_alerts" DROP CONSTRAINT "telemetry_alerts_pkey";
ALTER TABLE "telemetry_alerts" RENAME TO "telemetry_alerts_default";
ALTER INDEX "telemetry_alerts_alert_id_idx" RENAME TO "telemetry_alerts_default_alert_id_idx";

CREATE TABLE "telemetry_alerts" (
    "telemetry_id" UUID NOT NULL,
    "reading_timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT '1970-01-01 00:00:00+00'::timestamp with time zone,
    "alert_id" UUID NOT NULL,

    CONSTRAINT "telemetry_alerts_pkey" PRIMARY KEY ("telemetry_id", "alert_id", "reading_timestamp")
) PARTITION BY RANGE ("reading_timestamp");

CREATE INDEX "telemetry_alerts_alert_id_idx" ON "telemetry_alerts"("alert_id");

ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_telemetry_id_reading_timestamp_fkey" FOREIGN KEY ("telemetry_id", "reading_timestamp") REFERENCES "telemetry"("id", "timestamp") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "telemetry_alerts" ATTACH PARTITION "telemetry_alerts_default" DEFAULT;

-- TEMPORARY (see the header): rows without a reading_timestamp, written by the previous revision.
CREATE FUNCTION "telemetry_alerts_fill_reading_timestamp"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "telemetry_alerts" ("telemetry_id", "reading_timestamp", "alert_id")
  SELECT NEW."telemetry_id", t."timestamp", NEW."alert_id"
  FROM "telemetry" t
  WHERE t."id" = NEW."telemetry_id"
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'telemetry_alerts: reading % does not exist', NEW."telemetry_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL; -- the placeholder row is not stored
END
$$;

CREATE TRIGGER "telemetry_alerts_fill_reading_timestamp"
BEFORE INSERT ON "telemetry_alerts"
FOR EACH ROW
WHEN (NEW."reading_timestamp" = '1970-01-01 00:00:00+00'::timestamp with time zone)
EXECUTE FUNCTION "telemetry_alerts_fill_reading_timestamp"();

-- ---------------------------------------------------------------------------------------------
-- Partition management (called by the partition-maintenance job, src/wind/partitions.ts)

-- Creates the partitions of one UTC day for telemetry and telemetry_alerts (telemetry_pYYYYMMDD,
-- telemetry_alerts_pYYYYMMDD). Rows of that day that sit in the DEFAULT partitions (old data,
-- seed fixtures, CSV backfills, anything written before the partition existed) are moved into the
-- new partitions with their alerts: Postgres refuses to create a partition while the DEFAULT one
-- holds rows for its range. Returns false if the day already has its partitions. Safe to run
-- concurrently with ingestion: it blocks only writes routed to the DEFAULT partitions, briefly.
CREATE FUNCTION "telemetry_ensure_partition"(day date) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  lo timestamptz := (day::text || ' 00:00:00+00')::timestamptz;
  hi timestamptz := ((day + 1)::text || ' 00:00:00+00')::timestamptz;
  suffix text := to_char(day, 'YYYYMMDD');
  t_name text := 'telemetry_p' || suffix;
  a_name text := 'telemetry_alerts_p' || suffix;
BEGIN
  IF to_regclass(format('%I', t_name)) IS NOT NULL AND to_regclass(format('%I', a_name)) IS NOT NULL THEN
    RETURN false;
  END IF;
  PERFORM set_config('lock_timeout', '10s', true);
  PERFORM pg_advisory_xact_lock(hashtextextended('telemetry-partitions', 0));
  IF to_regclass(format('%I', t_name)) IS NOT NULL AND to_regclass(format('%I', a_name)) IS NOT NULL THEN
    RETURN false;
  END IF;

  -- Same order as ingestion writes (telemetry, then its alerts), so no deadlock with a batch.
  LOCK TABLE "telemetry_default" IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE "telemetry_alerts_default" IN ACCESS EXCLUSIVE MODE;

  -- Take the day's rows out of the DEFAULT partitions. Alerts first: deleting a reading cascades
  -- to its alerts, which would lose them.
  CREATE TEMP TABLE "_telemetry_move_alerts" (LIKE "telemetry_alerts_default") ON COMMIT DROP;
  CREATE TEMP TABLE "_telemetry_move_readings" (LIKE "telemetry_default") ON COMMIT DROP;
  WITH moved AS (
    DELETE FROM "telemetry_alerts_default"
    WHERE "reading_timestamp" >= lo AND "reading_timestamp" < hi
    RETURNING *
  ) INSERT INTO "_telemetry_move_alerts" SELECT * FROM moved;
  WITH moved AS (
    DELETE FROM "telemetry_default"
    WHERE "timestamp" >= lo AND "timestamp" < hi
    RETURNING *
  ) INSERT INTO "_telemetry_move_readings" SELECT * FROM moved;

  -- Standalone table + ATTACH (a SHARE UPDATE EXCLUSIVE lock on the parent, unlike CREATE TABLE
  -- ... PARTITION OF), then the rows back through the parent.
  IF to_regclass(format('%I', t_name)) IS NULL THEN
    EXECUTE format('CREATE TABLE %I (LIKE "telemetry" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)', t_name);
    EXECUTE format('ALTER TABLE "telemetry" ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', t_name, lo, hi);
  END IF;
  IF to_regclass(format('%I', a_name)) IS NULL THEN
    EXECUTE format('CREATE TABLE %I (LIKE "telemetry_alerts" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)', a_name);
    EXECUTE format('ALTER TABLE "telemetry_alerts" ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)', a_name, lo, hi);
  END IF;

  INSERT INTO "telemetry" ("id", "turbine_id", "farm_id", "timestamp", "received_at", "created_at",
                           "power_output_kw", "wind_speed_ms", "rotor_rpm", "blade_pitch_deg", "gearbox_temp_c")
  SELECT "id", "turbine_id", "farm_id", "timestamp", "received_at", "created_at",
         "power_output_kw", "wind_speed_ms", "rotor_rpm", "blade_pitch_deg", "gearbox_temp_c"
  FROM "_telemetry_move_readings";
  INSERT INTO "telemetry_alerts" ("telemetry_id", "reading_timestamp", "alert_id")
  SELECT "telemetry_id", "reading_timestamp", "alert_id" FROM "_telemetry_move_alerts";

  DROP TABLE "_telemetry_move_alerts";
  DROP TABLE "_telemetry_move_readings";
  RETURN true;
END
$$;

-- Drops the daily partitions (readings and their alerts together) that end at or before `cutoff`
-- (a UTC day boundary: the day `cutoff` itself is kept). Returns the number of days dropped.
-- The DEFAULT partitions are never touched here. A partition that readings' alerts reference can't
-- be dropped directly: the alerts go first, then the readings partition is detached and dropped.
-- DETACH (not CONCURRENTLY, which a DEFAULT partition forbids) and DROP lock the parent table
-- briefly, queuing ingestion's writes behind them; lock_timeout makes the job fail and retry
-- instead of stalling the writers for long.
CREATE FUNCTION "telemetry_drop_partitions_before"(cutoff date) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  part record;
  dropped integer := 0;
BEGIN
  PERFORM set_config('lock_timeout', '10s', true);
  PERFORM pg_advisory_xact_lock(hashtextextended('telemetry-partitions', 0));
  FOR part IN
    SELECT c.relname AS name, substring(c.relname FROM 'telemetry_p(\d{8})$') AS suffix
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'telemetry'::regclass
      AND c.relname ~ '^telemetry_p\d{8}$'
    ORDER BY c.relname
  LOOP
    IF to_date(part.suffix, 'YYYYMMDD') < cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', 'telemetry_alerts_p' || part.suffix);
      EXECUTE format('ALTER TABLE "telemetry" DETACH PARTITION %I', part.name);
      EXECUTE format('DROP TABLE %I', part.name);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END
$$;

-- Daily partitions for every day with readings in the last 31 days, and today through +3 days.
DO $$
DECLARE
  day date;
BEGIN
  FOR day IN
    SELECT DISTINCT ("timestamp" AT TIME ZONE 'UTC')::date
    FROM "telemetry_default"
    WHERE "timestamp" >= now() - interval '31 days'
    UNION
    SELECT d::date FROM generate_series((now() AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date + 3, interval '1 day') d
    ORDER BY 1
  LOOP
    PERFORM "telemetry_ensure_partition"(day);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- New tables (the DDL of `prisma migrate diff`, plus fillfactor and the backfill of turbine_latest)

-- CreateTable
CREATE TABLE "turbine_latest" (
    "turbine_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "reading_id" UUID NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "power_output_kw" DOUBLE PRECISION NOT NULL,
    "wind_speed_ms" DOUBLE PRECISION NOT NULL,
    "rotor_rpm" DOUBLE PRECISION NOT NULL,
    "blade_pitch_deg" DOUBLE PRECISION NOT NULL,
    "gearbox_temp_c" DOUBLE PRECISION NOT NULL,
    "worst_alert_level" "alert_level",

    CONSTRAINT "turbine_latest_pkey" PRIMARY KEY ("turbine_id")
);

-- One update per reading: leave room on each page for HOT-like in-page updates and less bloat.
ALTER TABLE "turbine_latest" SET (fillfactor = 70);

-- CreateTable
CREATE TABLE "farm_live_summary" (
    "farm_id" TEXT NOT NULL,
    "turbines" INTEGER NOT NULL,
    "commissioned" INTEGER NOT NULL,
    "reporting" INTEGER NOT NULL,
    "stale" INTEGER NOT NULL,
    "alerting" INTEGER NOT NULL,
    "power_output_kw" DOUBLE PRECISION NOT NULL,
    "wind_speed_ms" DOUBLE PRECISION,
    "as_of" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "farm_live_summary_pkey" PRIMARY KEY ("farm_id")
);

-- CreateTable
CREATE TABLE "anomaly_episodes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" TEXT NOT NULL,
    "metric" TEXT,
    "turbine_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "episode_start" TIMESTAMPTZ(3) NOT NULL,
    "episode_end" TIMESTAMPTZ(3) NOT NULL,
    "readings" INTEGER NOT NULL,
    "value" DOUBLE PRECISION,
    "wind_speed_ms" DOUBLE PRECISION,
    "lost_kwh" DOUBLE PRECISION,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomaly_episodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "anomaly_expected_power" (
    "wind_bin" INTEGER NOT NULL,
    "expected_kw" DOUBLE PRECISION NOT NULL,
    "readings" INTEGER NOT NULL,
    "computed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomaly_expected_power_pkey" PRIMARY KEY ("wind_bin")
);

-- CreateTable
CREATE TABLE "anomaly_rollup_state" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "anomaly_rollup_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "turbine_latest_farm_id_turbine_id_idx" ON "turbine_latest"("farm_id", "turbine_id");

-- CreateIndex
CREATE INDEX "turbine_latest_timestamp_idx" ON "turbine_latest"("timestamp");

-- CreateIndex
CREATE INDEX "anomaly_episodes_episode_end_idx" ON "anomaly_episodes"("episode_end");

-- CreateIndex
CREATE INDEX "anomaly_episodes_turbine_id_episode_start_idx" ON "anomaly_episodes"("turbine_id", "episode_start");

-- CreateIndex
CREATE INDEX "anomaly_episodes_farm_id_episode_end_idx" ON "anomaly_episodes"("farm_id", "episode_end");

-- CreateIndex
CREATE INDEX "turbines_turbine_id_trgm_idx" ON "turbines" USING GIN ("turbine_id" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "turbine_latest" ADD CONSTRAINT "turbine_latest_turbine_id_farm_id_fkey" FOREIGN KEY ("turbine_id", "farm_id") REFERENCES "turbines"("turbine_id", "farm_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "farm_live_summary" ADD CONSTRAINT "farm_live_summary_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_episodes" ADD CONSTRAINT "anomaly_episodes_turbine_id_farm_id_fkey" FOREIGN KEY ("turbine_id", "farm_id") REFERENCES "turbines"("turbine_id", "farm_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: each turbine's newest reading and the worst level among the rules it triggered.
INSERT INTO "turbine_latest" ("turbine_id", "farm_id", "reading_id", "timestamp", "received_at",
                              "power_output_kw", "wind_speed_ms", "rotor_rpm", "blade_pitch_deg",
                              "gearbox_temp_c", "worst_alert_level")
SELECT DISTINCT ON (t."turbine_id")
       t."turbine_id", t."farm_id", t."id", t."timestamp", t."received_at",
       t."power_output_kw", t."wind_speed_ms", t."rotor_rpm", t."blade_pitch_deg", t."gearbox_temp_c",
       (SELECT max(c."alert_level")
        FROM "telemetry_alerts" a
        JOIN "alerts_config" c ON c."id" = a."alert_id"
        WHERE a."telemetry_id" = t."id" AND a."reading_timestamp" = t."timestamp")
FROM "telemetry" t
ORDER BY t."turbine_id", t."timestamp" DESC;
