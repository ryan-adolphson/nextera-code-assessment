import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import {
  AbstractControl,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
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

/** A finite number (a number input yields null for anything else, so this guards the API). */
function finite(control: AbstractControl<number | null>): ValidationErrors | null {
  const value = control.value;
  return value === null || Number.isFinite(value) ? null : { finite: true };
}

/**
 * Add or edit an alert rule (opened by the Rules page with MatDialog). A typed Reactive Form on
 * Material fields; the native selects stay native (`matNativeControl`). Saving writes through
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
    ReactiveFormsModule,
  ],
  templateUrl: './rule-editor-dialog.html',
  host: { 'data-testid': 'rule-dialog' },
  changeDetection: ChangeDetectionStrategy.OnPush,
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

  protected readonly form = new FormGroup({
    metric: new FormControl<TelemetryMetric>(this.editing?.measurementMetric ?? DEFAULTS.metric, {
      nonNullable: true,
    }),
    comparison: new FormControl<AlertComparison>(this.editing?.comparison ?? DEFAULTS.comparison, {
      nonNullable: true,
    }),
    value: new FormControl<number | null>(this.editing?.valueMetric ?? null, [
      Validators.required,
      finite,
    ]),
    level: new FormControl<AlertLevel>(this.editing?.alertLevel ?? DEFAULTS.level, {
      nonNullable: true,
    }),
  });

  private readonly metric = toSignal(this.form.controls.metric.valueChanges, {
    initialValue: this.form.controls.metric.value,
  });
  protected readonly unit = computed(() => metricOf(this.metric()).unit);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The threshold's message (shown by `<mat-error>` once the form was submitted). */
  protected valueError(): string {
    return this.form.controls.value.hasError('required')
      ? 'Enter a threshold value.'
      : 'Enter a number, e.g. 120 or -5.5.';
  }

  protected save(): void {
    this.error.set(null);
    if (this.form.invalid || this.saving()) return;
    const { metric, comparison, value, level } = this.form.getRawValue();
    const rule: AlertConfigInput = {
      measurementMetric: metric,
      comparison,
      valueMetric: value!,
      alertLevel: level,
    };
    const editing = this.editing;
    this.saving.set(true);
    (editing ? this.api.update(editing.id, rule) : this.api.create(rule))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        complete: () => this.dialog.close({ action: editing ? 'updated' : 'added', rule }),
        error: (e: unknown) => {
          this.saving.set(false);
          // One rule per metric, condition and level (unique in the database): say so in words,
          // and reload the list behind the dialog (it may be stale: changed in another browser).
          if (statusOf(e) === 409) {
            this.error.set(duplicateMessage(rule));
            this.rules?.reload();
          } else {
            this.error.set(errorMessage(e));
          }
        },
      });
  }
}
