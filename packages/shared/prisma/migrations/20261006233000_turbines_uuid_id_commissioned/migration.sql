-- turbines: the business key "id" ('TURB001') becomes "turbine_id", a new UUID "id" becomes the
-- primary key, and "commissioned" is added (false for every existing turbine).
--
-- Written by hand: `prisma migrate diff` would DROP the old "id" column and ADD an empty
-- "turbine_id" (data loss, and NOT NULL fails on existing rows). Here the column is RENAMED, so
-- every turbine keeps its business key and telemetry stays linked: Postgres FKs and indexes follow
-- column renames; only the index name is changed to the one Prisma expects.
--
-- EXCEPTION to the expand -> deploy -> contract rule (accepted by the user): this is NOT
-- backward-compatible with the running revision. The previous API and worker query turbines.id as
-- the business key ('TURB001'); after this migration that column is a UUID, so their turbine
-- lookups fail until the new revisions are live (the minute between `migrate deploy` and
-- `gcloud run deploy`). Telemetry pushed meanwhile gets 4xx/5xx and Pub/Sub redelivers it.

-- 1. Keep the business key under its new name. The composite unique index (target of
--    telemetry_turbine_id_farm_id_fkey) and the FK itself now cover turbines(turbine_id, farm_id).
ALTER TABLE "turbines" RENAME COLUMN "id" TO "turbine_id";
ALTER INDEX "turbines_id_farm_id_key" RENAME TO "turbines_turbine_id_farm_id_key";

-- 2. The business key stays unique on its own (built before the primary key moves away from it).
CREATE UNIQUE INDEX "turbines_turbine_id_key" ON "turbines"("turbine_id");

-- 3. New surrogate key. gen_random_uuid() is volatile, so every existing row gets its own value.
ALTER TABLE "turbines" ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE "turbines" DROP CONSTRAINT "turbines_pkey";
ALTER TABLE "turbines" ADD CONSTRAINT "turbines_pkey" PRIMARY KEY ("id");

-- 4. Commissioning flag; existing turbines are not commissioned.
ALTER TABLE "turbines" ADD COLUMN "commissioned" BOOLEAN NOT NULL DEFAULT false;
