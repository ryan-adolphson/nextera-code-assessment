import { listAlertRules } from '@nextera/shared';
import { z } from 'zod';
import { defineTool } from './tool.js';

export const listAlertRulesTool = defineTool({
  name: 'list_alert_rules',
  title: 'List alert rules',
  description:
    'The alert thresholds ingestion evaluates on every new reading: metric, comparison ' +
    '(above/below, strict), threshold value and level (info < warn < error). Disabled rules ' +
    'are kept (and still shown on readings they flagged) but not evaluated.',
  inputSchema: {
    includeDisabled: z
      .boolean()
      .default(true)
      .describe('Also list disabled rules (default true).'),
  },
  run({ db }, { includeDisabled }) {
    return listAlertRules(db, { includeDisabled });
  },
});
