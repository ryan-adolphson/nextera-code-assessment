-- CreateEnum
CREATE TYPE "measurement_metric" AS ENUM ('power_output_kw', 'wind_speed_ms', 'rotor_rpm', 'blade_pitch_deg', 'gearbox_temp_c');

-- CreateEnum
CREATE TYPE "alert_comparison" AS ENUM ('above', 'below');

-- CreateEnum
CREATE TYPE "alert_level" AS ENUM ('info', 'warn', 'error');

-- CreateTable
CREATE TABLE "alerts_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "measurement_metric" "measurement_metric" NOT NULL,
    "comparison" "alert_comparison" NOT NULL,
    "value_metric" DOUBLE PRECISION NOT NULL,
    "alert_level" "alert_level" NOT NULL,

    CONSTRAINT "alerts_config_pkey" PRIMARY KEY ("id")
);
