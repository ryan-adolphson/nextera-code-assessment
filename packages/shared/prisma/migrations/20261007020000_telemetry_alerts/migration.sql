-- telemetry_alerts: the alert rules each telemetry reading triggered (written by ingestion). A join
-- table rather than an array column, so both ids are real foreign keys. Backward-compatible: it
-- only adds a table, which the running revision never touches.
-- CreateTable
CREATE TABLE "telemetry_alerts" (
    "telemetry_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,

    CONSTRAINT "telemetry_alerts_pkey" PRIMARY KEY ("telemetry_id","alert_id")
);

-- CreateIndex
CREATE INDEX "telemetry_alerts_alert_id_idx" ON "telemetry_alerts"("alert_id");

-- AddForeignKey
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_telemetry_id_fkey" FOREIGN KEY ("telemetry_id") REFERENCES "telemetry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "telemetry_alerts" ADD CONSTRAINT "telemetry_alerts_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "alerts_config"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

