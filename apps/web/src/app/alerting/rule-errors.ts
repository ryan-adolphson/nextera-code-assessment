import { errorMessage, statusOf } from '../core/http-errors';
import { RuleCondition, describeRule, levelLabel, metricOf } from './alert-config.model';

/** A 409 from /api/alert-configs: one rule per metric, condition and level, in words. */
export function duplicateMessage(rule: RuleCondition): string {
  const level = levelLabel(rule.alertLevel);
  const article = /^[AEIOU]/.test(level) ? 'An' : 'A';
  const metric = metricOf(rule.measurementMetric).label;
  return (
    `${article} ${level} rule for “${metric} ${rule.comparison}” already exists. ` +
    'Edit that rule, or choose another condition or level.'
  );
}

/**
 * DELETE /api/alert-configs/:id answers 409 only when readings triggered the rule (the
 * telemetry_alerts foreign key keeps their history): offer to disable it instead. Mapped by the
 * status of that request, never by the API's text (which names the rule's internal id).
 */
export function triggeredMessage(enabled: boolean): string {
  const reason =
    'This rule has flagged readings, so it can’t be deleted — they keep their history.';
  return enabled
    ? `${reason} Disable it instead to stop it from being evaluated.`
    : `${reason} It’s already disabled, so it isn’t evaluated.`;
}

/** A 404 from /api/alert-configs/:id: the rule was deleted elsewhere (the API's text names its id). */
export const RULE_GONE_MESSAGE = 'This rule no longer exists: it was deleted elsewhere.';

/**
 * Why an enable/disable PATCH failed, in words: a 404 means the rule is gone, anything else keeps
 * the shared wording (connection, validation, server).
 */
export function toggleErrorMessage(error: unknown, enable: boolean, rule: RuleCondition): string {
  const reason = statusOf(error) === 404 ? RULE_GONE_MESSAGE : errorMessage(error);
  return `Could not ${enable ? 'enable' : 'disable'} “${describeRule(rule)}”. ${reason}`;
}
