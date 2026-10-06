-- One alert rule per (metric, comparison, level). Backward-compatible: the running API revision
-- only reads alerts_config, and nothing writes it yet. If duplicates already existed this would
-- fail, and the deploy workflow stops before any service rolls out.

-- CreateIndex
CREATE UNIQUE INDEX "alerts_config_measurement_metric_comparison_alert_level_key" ON "alerts_config"("measurement_metric", "comparison", "alert_level");
