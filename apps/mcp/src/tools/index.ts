import { getReportSummaryTool } from './report-summary.js';
import { getTelemetryStatsTool } from './get-telemetry-stats.js';
import { getTelemetryTool } from './get-telemetry.js';
import { getTurbineTool } from './get-turbine.js';
import { listAlertRulesTool } from './list-alert-rules.js';
import { listAlertsTool } from './list-alerts.js';
import { listFarmsTool } from './list-farms.js';
import type { Tool } from './tool.js';

/** Every tool the server registers. All of them only read. */
export const TOOLS = [
  listFarmsTool,
  getTurbineTool,
  getTelemetryTool,
  getTelemetryStatsTool,
  listAlertsTool,
  listAlertRulesTool,
  getReportSummaryTool,
] as unknown as readonly Tool[];
