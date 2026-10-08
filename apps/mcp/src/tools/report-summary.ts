import { MAX_QUERY_RANGE_DAYS, reportSummary } from '@nextera/shared';
import { businessKey, defineTool, timestamp } from './tool.js';

export const getReportSummaryTool = defineTool({
  name: 'get_report_summary',
  title: 'Summarise a farm or turbine over a range',
  description:
    'A summary of every reading of one farm or one turbine measured in [from, to) (at most ' +
    `${MAX_QUERY_RANGE_DAYS} days): reading count, first and last measurement time, min/avg/max ` +
    'per metric, readings flagged by alert rules and rule triggers per level. Give exactly ' +
    'one of farmId and turbineId. Aggregated in Postgres; use get_telemetry for the rows.',
  inputSchema: {
    farmId: businessKey(
      'A farm id, e.g. "FARM01" (or give turbineId).',
    ).optional(),
    turbineId: businessKey(
      'A turbine id, e.g. "TURB002" (or give farmId).',
    ).optional(),
    from: timestamp('from', 'Inclusive lower bound on measurement time.'),
    to: timestamp(
      'to',
      'Exclusive upper bound on measurement time (may be in the future).',
    ),
  },
  run({ db }, args) {
    return reportSummary(db, args);
  },
});
