-- Unallocated turbines: readings ingestion can't store in telemetry (an unknown turbine id, or a
-- farm_id that isn't the turbine's farm) are held per (turbine id, reported farm) until an owner
-- assigns, keeps, moves or blocks them, instead of being rejected (400 → dead-letter topic).
--
-- Expand-only and backward-compatible: two enum types and two new tables; nothing existing is
-- touched. The running revision never reads them and keeps rejecting those readings with 400
-- until the new ingestion revision is live.
--
-- Moving a turbine to another farm relies on the existing telemetry_turbine_id_farm_id_fkey being
-- ON UPDATE CASCADE (checked: it still is after 20261006233000 renamed turbines.id), so
-- UPDATE turbines SET farm_id carries the turbine's telemetry along.

-- CreateEnum
CREATE TYPE "unallocated_kind" AS ENUM ('unknown_turbine', 'farm_mismatch');

-- CreateEnum
CREATE TYPE "unallocated_status" AS ENUM ('pending', 'blocked');

-- CreateTable
CREATE TABLE "unallocated_turbines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "turbine_id" TEXT NOT NULL,
    "reported_farm_id" TEXT NOT NULL,
    "kind" "unallocated_kind" NOT NULL,
    "status" "unallocated_status" NOT NULL DEFAULT 'pending',
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
    "blocked_at" TIMESTAMPTZ(3),
    "blocked_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unallocated_turbines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "held_telemetry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "unallocated_id" UUID NOT NULL,
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

    CONSTRAINT "held_telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "unallocated_turbines_status_last_seen_at_idx" ON "unallocated_turbines"("status", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "unallocated_turbines_turbine_id_reported_farm_id_key" ON "unallocated_turbines"("turbine_id", "reported_farm_id");

-- CreateIndex
CREATE UNIQUE INDEX "held_telemetry_unallocated_id_timestamp_key" ON "held_telemetry"("unallocated_id", "timestamp");

-- AddForeignKey
ALTER TABLE "unallocated_turbines" ADD CONSTRAINT "unallocated_turbines_blocked_by_fkey" FOREIGN KEY ("blocked_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_telemetry" ADD CONSTRAINT "held_telemetry_unallocated_id_fkey" FOREIGN KEY ("unallocated_id") REFERENCES "unallocated_turbines"("id") ON DELETE CASCADE ON UPDATE CASCADE;

