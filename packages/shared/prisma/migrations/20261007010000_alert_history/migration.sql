-- alerts_config.enabled: disabled rules are kept but not evaluated. Backward-compatible: a constant
-- default is a metadata-only change, and inserts from the running revision get true.
-- alert_history: one row per alert occurrence (open while resolved_at is null). Both foreign keys
-- are RESTRICT, so history is never lost: rules with history are disabled, not deleted.
-- AlterTable
ALTER TABLE "alerts_config" ADD COLUMN     "enabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "alert_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "turbine_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "alert_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "alert_history_turbine_id_created_at_idx" ON "alert_history"("turbine_id", "created_at");

-- CreateIndex
CREATE INDEX "alert_history_alert_id_idx" ON "alert_history"("alert_id");

-- AddForeignKey
ALTER TABLE "alert_history" ADD CONSTRAINT "alert_history_turbine_id_fkey" FOREIGN KEY ("turbine_id") REFERENCES "turbines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_history" ADD CONSTRAINT "alert_history_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

