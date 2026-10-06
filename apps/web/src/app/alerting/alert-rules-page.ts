import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';
import { TelemetryMetric } from '../fleet/fleet.model';
import { ModalDialog } from '../ui/modal-dialog';
import { AlertConfigApi } from './alert-config-api.service';
import {
  ALERT_COMPARISONS,
  ALERT_METRICS,
  ALERT_RULE_LEVELS,
  AlertComparison,
  AlertConfig,
  AlertConfigInput,
  AlertLevel,
  describeRule,
  formatThreshold,
  levelLabel,
  metricOf,
} from './alert-config.model';
import { AlertLevelBadge } from './alert-level-badge';
import { AlertRulesStore } from './alert-rules.store';
import { AlertingTabs } from './alerting-tabs';

const DEFAULT_RULE: AlertConfigInput = {
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: NaN,
  alertLevel: 'warn',
};

/**
 * /alerting/rules: the alert thresholds, with add, edit and delete. The list is the shell's
 * AlertRulesStore (shared with the Turbines table): reloaded after every write here and on
 * `alert-config.changed` (any browser's edits, over the shell's SSE stream).
 */
@Component({
  selector: 'app-alert-rules-page',
  imports: [AlertLevelBadge, AlertingTabs, ModalDialog],
  templateUrl: './alert-rules-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertRulesPage {
  private readonly api = inject(AlertConfigApi);
  protected readonly store = inject(AlertRulesStore);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly metrics = ALERT_METRICS;
  protected readonly comparisons = ALERT_COMPARISONS;
  protected readonly levels = ALERT_RULE_LEVELS;
  protected readonly metricOf = metricOf;
  protected readonly levelLabel = levelLabel;
  protected readonly formatThreshold = formatThreshold;
  protected readonly describeRule = describeRule;

  // --- List -------------------------------------------------------------------------------
  /** Last outcome, announced politely ("Rule added." …). */
  protected readonly notice = signal('');

  // --- Add / edit dialog ------------------------------------------------------------------
  protected readonly editorOpen = signal(false);
  /** The rule being edited; null while adding. */
  protected readonly editing = signal<AlertConfig | null>(null);
  protected readonly metric = signal<TelemetryMetric>(DEFAULT_RULE.measurementMetric);
  protected readonly comparison = signal<AlertComparison>(DEFAULT_RULE.comparison);
  protected readonly level = signal<AlertLevel>(DEFAULT_RULE.alertLevel);
  /** The threshold as typed (validated on save). */
  protected readonly value = signal('');
  protected readonly submitted = signal(false);
  protected readonly saving = signal(false);
  protected readonly editorError = signal<string | null>(null);
  protected readonly valueError = computed(() => {
    const raw = this.value().trim();
    if (!raw) return 'Enter a threshold value.';
    return Number.isFinite(Number(raw)) ? null : 'Enter a number, e.g. 120 or -5.5.';
  });
  protected readonly unit = computed(() => metricOf(this.metric()).unit);

  // --- Delete confirmation ----------------------------------------------------------------
  protected readonly deleting = signal<AlertConfig | null>(null);
  protected readonly deleteBusy = signal(false);
  protected readonly deleteError = signal<string | null>(null);

  protected reload(): void {
    this.store.reload();
  }

  // --- Add / edit -------------------------------------------------------------------------

  protected openAdd(): void {
    this.openEditor(null, DEFAULT_RULE);
  }

  protected openEdit(rule: AlertConfig): void {
    this.openEditor(rule, rule);
  }

  private openEditor(rule: AlertConfig | null, values: AlertConfigInput): void {
    this.editing.set(rule);
    this.metric.set(values.measurementMetric);
    this.comparison.set(values.comparison);
    this.level.set(values.alertLevel);
    this.value.set(Number.isFinite(values.valueMetric) ? String(values.valueMetric) : '');
    this.submitted.set(false);
    this.editorError.set(null);
    this.editorOpen.set(true);
  }

  protected closeEditor(): void {
    this.editorOpen.set(false);
  }

  protected save(): void {
    this.submitted.set(true);
    this.editorError.set(null);
    if (this.valueError() || this.saving()) return;
    const rule: AlertConfigInput = {
      measurementMetric: this.metric(),
      comparison: this.comparison(),
      valueMetric: Number(this.value().trim()),
      alertLevel: this.level(),
    };
    const editing = this.editing();
    this.write(
      editing ? this.api.update(editing.id, rule) : this.api.create(rule),
      this.saving,
      this.editorError,
      () => {
        this.editorOpen.set(false);
        this.notice.set(
          editing ? `Rule updated: ${describeRule(rule)}.` : `Rule added: ${describeRule(rule)}.`,
        );
      },
      // One rule per metric, condition and level (unique in the database): say so in words.
      { 409: () => this.editorError.set(duplicateMessage(rule)) },
    );
  }

  // --- Delete -----------------------------------------------------------------------------

  protected confirmDelete(rule: AlertConfig): void {
    this.deleteError.set(null);
    this.deleting.set(rule);
  }

  protected cancelDelete(): void {
    this.deleting.set(null);
  }

  protected delete(): void {
    const rule = this.deleting();
    if (!rule || this.deleteBusy()) return;
    this.deleteError.set(null);
    const done = () => {
      this.deleting.set(null);
      this.notice.set(`Rule deleted: ${describeRule(rule)}.`);
    };
    this.write(this.api.remove(rule.id), this.deleteBusy, this.deleteError, done, {
      404: done, // already gone (deleted elsewhere): the list reload shows it
    });
  }

  /**
   * Runs a write: on success closes/announces and reloads the list; statuses in `handled` get
   * their own handling (plus a reload); any other failure is shown in `error`.
   */
  private write(
    request: Observable<unknown>,
    busy: WritableSignal<boolean>,
    error: WritableSignal<string | null>,
    onSuccess: () => void,
    handled: Record<number, () => void> = {},
  ): void {
    busy.set(true);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => undefined,
      complete: () => {
        busy.set(false);
        onSuccess();
        this.reload();
      },
      error: (e: unknown) => {
        busy.set(false);
        const status = e instanceof HttpErrorResponse ? e.status : 0;
        if (handled[status]) {
          handled[status]();
          this.reload(); // the list may be stale (the rule was changed elsewhere)
        } else {
          error.set(errorMessage(e));
        }
      },
    });
  }
}

function duplicateMessage(rule: AlertConfigInput): string {
  const level = levelLabel(rule.alertLevel);
  const article = /^[AEIOU]/.test(level) ? 'An' : 'A';
  const metric = metricOf(rule.measurementMetric).label;
  return (
    `${article} ${level} rule for “${metric} ${rule.comparison}” already exists. ` +
    'Edit that rule, or choose another condition or level.'
  );
}

/** The API's message (a string or class-validator's list), or a generic one. */
function errorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return 'Something went wrong. Try again.';
  if (error.status === 0) return 'Could not reach the API. Check your connection and try again.';
  const message: unknown = error.error?.message;
  if (Array.isArray(message) && message.length) return message.join('. ') + '.';
  if (typeof message === 'string' && message)
    return message.endsWith('.') ? message : `${message}.`;
  return `The request failed (HTTP ${error.status}).`;
}
