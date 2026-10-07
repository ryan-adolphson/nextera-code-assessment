import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormField, FormRoot, form, required, validate } from '@angular/forms/signals';
import { MatButton } from '@angular/material/button';
import {
  MAT_DIALOG_DATA,
  MatDialogActions,
  MatDialogClose,
  MatDialogContent,
  MatDialogRef,
  MatDialogTitle,
} from '@angular/material/dialog';
import { MatError, MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { MatInput } from '@angular/material/input';
import { TelemetryMetric } from '../fleet/fleet.model';
import { AlertConfigApi } from './alert-config-api.service';
import { AlertRulesStore } from './alert-rules.store';
import {
  ALERT_COMPARISONS,
  ALERT_METRICS,
  ALERT_RULE_LEVELS,
  AlertComparison,
  AlertConfig,
  AlertConfigInput,
  AlertLevel,
  metricOf,
} from './alert-config.model';
import { duplicateMessage, errorMessage, statusOf } from './rule-errors';

/** What the Rules page passes in: the rule to edit, or null to add one. */
export interface RuleEditorData {
  rule: AlertConfig | null;
}

/** What the dialog closes with after a successful save (undefined when cancelled). */
export interface RuleEditorResult {
  action: 'added' | 'updated';
  rule: AlertConfigInput;
}

const DEFAULTS = {
  metric: 'gearboxTempC',
  comparison: 'above',
  level: 'warn',
} as const satisfies Record<string, string>;

/** The editor's model: what the fields show (the threshold is null while empty). */
interface RuleModel {
  metric: TelemetryMetric;
  comparison: AlertComparison;
  threshold: number | null;
  level: AlertLevel;
}

/**
 * Add or edit an alert rule (opened by the Rules page with MatDialog). A Signal Form on Material
 * fields (`[formField]`; Material reads the field's state for its error state and `required`); the
 * native selects stay native (`matNativeControl`). `[formRoot]` submits it: every field is marked
 * touched (so `<mat-error>` shows), and only a valid form runs the save action. Saving writes through
 * AlertConfigApi here, so a duplicate (409) or another failure is shown in the open dialog; it
 * closes with a `RuleEditorResult` only on success. MatDialog provides the role, the title as
 * `aria-labelledby`, Esc, focus trapping, focus on the first field and focus return.
 */
@Component({
  selector: 'app-rule-editor-dialog',
  imports: [
    MatButton,
    MatDialogActions,
    MatDialogClose,
    MatDialogContent,
    MatDialogTitle,
    MatError,
    MatFormField,
    MatInput,
    MatLabel,
    MatSuffix,
    FormField,
    FormRoot,
  ],
  templateUrl: './rule-editor-dialog.html',
  host: { 'data-testid': 'rule-dialog' },
})
export class RuleEditorDialog {
  private readonly api = inject(AlertConfigApi);
  private readonly dialog = inject<MatDialogRef<RuleEditorDialog, RuleEditorResult>>(MatDialogRef);
  private readonly destroyRef = inject(DestroyRef);
  /** The Rules page's list (the page opens this dialog in its own injector). */
  private readonly rules = inject(AlertRulesStore, { optional: true });
  protected readonly editing = inject<RuleEditorData>(MAT_DIALOG_DATA).rule;

  protected readonly metrics = ALERT_METRICS;
  protected readonly comparisons = ALERT_COMPARISONS;
  protected readonly levels = ALERT_RULE_LEVELS;

  private readonly model = signal<RuleModel>({
    metric: this.editing?.measurementMetric ?? DEFAULTS.metric,
    comparison: this.editing?.comparison ?? DEFAULTS.comparison,
    threshold: this.editing?.valueMetric ?? null,
    level: this.editing?.alertLevel ?? DEFAULTS.level,
  });
  protected readonly ruleForm = form(
    this.model,
    (rule) => {
      required(rule.threshold);
      // A finite number (a number input yields null for anything else, so this guards the API).
      validate(rule.threshold, ({ value }) => {
        const threshold = value();
        return threshold === null || Number.isFinite(threshold) ? undefined : { kind: 'finite' };
      });
    },
    {
      submission: {
        action: () => this.save(),
        onInvalid: () => this.error.set(null),
      },
    },
  );

  protected readonly unit = computed(() => metricOf(this.model().metric).unit);
  /** A save is in flight (`submit()` also ignores a second submit meanwhile). */
  protected readonly saving = computed(() => this.ruleForm().submitting());
  protected readonly error = signal<string | null>(null);

  /** The threshold's message (shown by `<mat-error>` once the field was touched or submitted). */
  protected valueError(): string {
    return this.ruleForm.threshold().getError('required')
      ? 'Enter a threshold value.'
      : 'Enter a number, e.g. 120 or -5.5.';
  }

  /**
   * The submit action (valid form only): POST or PATCH, then close with the result. Resolves when
   * the request ends; failures are shown in the dialog (`error`), not as field errors.
   */
  private save(): Promise<undefined> {
    this.error.set(null);
    const { metric, comparison, threshold, level } = this.model();
    const rule: AlertConfigInput = {
      measurementMetric: metric,
      comparison,
      valueMetric: threshold!,
      alertLevel: level,
    };
    const editing = this.editing;
    return new Promise((resolve) =>
      (editing ? this.api.update(editing.id, rule) : this.api.create(rule))
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({
          complete: () => {
            this.dialog.close({ action: editing ? 'updated' : 'added', rule });
            resolve(undefined);
          },
          error: (e: unknown) => {
            // One rule per metric, condition and level (unique in the database): say so in words,
            // and reload the list behind the dialog (it may be stale: changed in another browser).
            if (statusOf(e) === 409) {
              this.error.set(duplicateMessage(rule));
              this.rules?.reload();
            } else {
              this.error.set(errorMessage(e));
            }
            resolve(undefined);
          },
        }),
    );
  }
}
