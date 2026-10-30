import { AlertConfigInput, levelLabel, metricOf } from './alert-config.model';

/** A 409 from /api/alert-configs: one rule per metric, condition and level, in words. */
export function duplicateMessage(rule: AlertConfigInput): string {
  const level = levelLabel(rule.alertLevel);
  const article = /^[AEIOU]/.test(level) ? 'An' : 'A';
  const metric = metricOf(rule.measurementMetric).label;
  return (
    `${article} ${level} rule for “${metric} ${rule.comparison}” already exists. ` +
    'Edit that rule, or choose another condition or level.'
  );
}
