-- Replaces the sample "orders" domain with wind-farm telemetry.
-- Destructive (drops orders / ingested_messages): acceptable only because nothing had been deployed;
-- a deployed system would need expand -> migrate data -> contract instead.

-- DropTable
DROP TABLE "ingested_messages";

-- DropTable
DROP TABLE "orders";

-- DropEnum
DROP TYPE "OrderStatus";

-- CreateTable
CREATE TABLE "farms" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,

    CONSTRAINT "farms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "turbines" (
    "id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,

    CONSTRAINT "turbines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry" (
    "id" UUID NOT NULL,
    "turbine_id" TEXT NOT NULL,
    "farm_id" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "power_output_kw" DOUBLE PRECISION NOT NULL,
    "wind_speed_ms" DOUBLE PRECISION NOT NULL,
    "rotor_rpm" DOUBLE PRECISION NOT NULL,
    "blade_pitch_deg" DOUBLE PRECISION NOT NULL,
    "gearbox_temp_c" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "telemetry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "turbines_farm_id_idx" ON "turbines"("farm_id");

-- CreateIndex
CREATE UNIQUE INDEX "turbines_id_farm_id_key" ON "turbines"("id", "farm_id");

-- CreateIndex
CREATE INDEX "telemetry_farm_id_timestamp_idx" ON "telemetry"("farm_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_turbine_id_timestamp_key" ON "telemetry"("turbine_id", "timestamp");

-- AddForeignKey
ALTER TABLE "turbines" ADD CONSTRAINT "turbines_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_turbine_id_farm_id_fkey" FOREIGN KEY ("turbine_id", "farm_id") REFERENCES "turbines"("id", "farm_id") ON DELETE RESTRICT ON UPDATE CASCADE;

