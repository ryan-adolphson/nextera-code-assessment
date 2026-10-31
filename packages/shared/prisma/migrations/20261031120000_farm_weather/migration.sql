-- Farm weather: hourly Open-Meteo weather per farm (one series at the farm's coordinates), written
-- by the weather sync (`node dist/weather-sync/main.js`, `npm run weather:sync`). Daily figures
-- are computed from these rows on read, so nothing else is stored.
--
-- Expand-only and backward-compatible: one enum type and one new table; nothing existing is
-- touched. The running revision never reads it. Deleting a farm deletes its weather (CASCADE),
-- unlike turbines (RESTRICT): weather only describes the farm's location.
--
-- Note: a TRUNCATE of farms must now include farm_weather_hourly (or CASCADE).

-- CreateEnum
CREATE TYPE "weather_source" AS ENUM ('archive', 'forecast');

-- CreateTable
CREATE TABLE "farm_weather_hourly" (
    "farm_id" TEXT NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "source" "weather_source" NOT NULL,
    "wind_speed_10m_ms" DOUBLE PRECISION,
    "wind_speed_100m_ms" DOUBLE PRECISION,
    "wind_direction_10m_deg" DOUBLE PRECISION,
    "wind_direction_100m_deg" DOUBLE PRECISION,
    "wind_gusts_10m_ms" DOUBLE PRECISION,
    "temperature_2m_c" DOUBLE PRECISION,
    "relative_humidity_2m_pct" DOUBLE PRECISION,
    "surface_pressure_hpa" DOUBLE PRECISION,
    "precipitation_mm" DOUBLE PRECISION,
    "cloud_cover_pct" DOUBLE PRECISION,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_weather_hourly_pkey" PRIMARY KEY ("farm_id","time")
);

-- AddForeignKey
ALTER TABLE "farm_weather_hourly" ADD CONSTRAINT "farm_weather_hourly_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

