-- Farm weather: 30-minute Open-Meteo weather per farm (one series at the farm's coordinates),
-- aggregated from the forecast models' 15-minute values and written by the weather sync
-- (`node dist/weather-sync/main.js`, `npm run weather:sync`). Daily figures are computed from
-- these rows on read, so nothing else is stored.
--
-- Expand-only and backward-compatible: one new table; nothing existing is touched. The running
-- revision never reads it. Deleting a farm deletes its weather (CASCADE), unlike turbines
-- (RESTRICT): weather only describes the farm's location.
--
-- Note: a TRUNCATE of farms must now include farm_weather (or CASCADE).

-- CreateTable
CREATE TABLE "farm_weather" (
    "farm_id" TEXT NOT NULL,
    "time" TIMESTAMPTZ(3) NOT NULL,
    "samples" SMALLINT NOT NULL,
    "wind_speed_10m_ms" DOUBLE PRECISION,
    "wind_speed_80m_ms" DOUBLE PRECISION,
    "wind_direction_10m_deg" DOUBLE PRECISION,
    "wind_direction_80m_deg" DOUBLE PRECISION,
    "wind_gusts_10m_ms" DOUBLE PRECISION,
    "temperature_2m_c" DOUBLE PRECISION,
    "relative_humidity_2m_pct" DOUBLE PRECISION,
    "surface_pressure_hpa" DOUBLE PRECISION,
    "precipitation_mm" DOUBLE PRECISION,
    "cloud_cover_pct" DOUBLE PRECISION,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "farm_weather_pkey" PRIMARY KEY ("farm_id","time")
);

-- AddForeignKey
ALTER TABLE "farm_weather" ADD CONSTRAINT "farm_weather_farm_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
