import { getFarmDailyTool } from './get-farm-daily.js';
import { getReportSummaryTool } from './report-summary.js';
import { getTelemetryStatsTool } from './get-telemetry-stats.js';
import { getTelemetryTool } from './get-telemetry.js';
import { getTurbineTool } from './get-turbine.js';
import { getWeatherTool } from './get-weather.js';
import { listAlertRulesTool } from './list-alert-rules.js';
import { listAlertsTool } from './list-alerts.js';
import { listAnomaliesTool } from './list-anomalies.js';
import { listFarmsTool } from './list-farms.js';
import type { Tool } from './tool.js';
import {
  getUnallocatedReadingsTool,
  listUnallocatedTool,
} from './unallocated.js';

/** Every tool the server registers. All of them only read. */
export const TOOLS: readonly Tool[] = [
  listFarmsTool,
  getTurbineTool,
  getTelemetryTool,
  getTelemetryStatsTool,
  listAlertsTool,
  listAlertRulesTool,
  listAnomaliesTool,
  getReportSummaryTool,
  getWeatherTool,
  getFarmDailyTool,
  listUnallocatedTool,
  getUnallocatedReadingsTool,
];
