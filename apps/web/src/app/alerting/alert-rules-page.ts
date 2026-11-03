import { Component, DestroyRef, ViewContainerRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatDialog, MatDialogConfig } from '@angular/material/dialog';
import { MatSlideToggle } from '@angular/material/slide-toggle';
import { AuthStore } from '../core/auth/auth.store';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AlertConfig, describeRule, formatThreshold, metricOf } from './alert-config.model';
import { AlertLevelBadge } from './alert-level-badge';
import { AlertRulesStore } from './alert-rules.store';
import { AlertingTabs } from './alerting-tabs';
import { AlertConfigApi } from './alert-config-api.service';
import { DeleteRuleDialog, DeleteRuleResult } from './delete-rule-dialog';
import { toggleErrorMessage } from './rule-errors';
import { RuleEditorData, RuleEditorDialog, RuleEditorResult } from './rule-editor-dialog';

/**
 * Both dialogs: up to 32rem (never wider than the screen less a margin), modal, focus on the first
 * field (or `cdkFocusInitial`).
 */
const DIALOG_CONFIG: MatDialogConfig = {
  width: '32rem',
  maxWidth: 'calc(100vw - 2rem)',
  autoFocus: 'first-tabbable',
  ariaModal: true,
};

/**
 * /alerting/rules: the alert thresholds, with add, edit, enable/disable and delete. The list is this page's
 * AlertRulesStore: reloaded after every write here and on `alert-config.changed` (any browser's
 * edits, over the shell's SSE stream). Adding, editing and deleting happen in Material dialogs
 * (`RuleEditorDialog`, `DeleteRuleDialog`), which do the write and keep errors inside; the page
 * announces the outcome and reloads. Owners and admins switch a rule on or off in its row
 * (`mat-slide-toggle`, PATCH `enabled`): optimistic, rolled back with an error if it fails.
 */
@Component({
  selector: 'app-alert-rules-page',
  // Its own rules store (only this page uses it); it follows the shell's FleetStore for
  // `alert-config.changed`.
  providers: [AlertRulesStore],
  imports: [AlertLevelBadge, AlertingTabs, MatButton, MatSlideToggle, TABLE_IMPORTS],
  templateUrl: './alert-rules-page.html',
})
export class AlertRulesPage {
  protected readonly store = inject(AlertRulesStore);
  /** Viewers see the rules; owners and admins also add, edit and delete them (the API enforces it). */
  private readonly auth = inject(AuthStore);
  protected readonly canEdit = computed(() => this.auth.can('owner'));
  private readonly dialog = inject(MatDialog);
  private readonly api = inject(AlertConfigApi);
  private readonly destroyRef = inject(DestroyRef);
  /** Opening dialogs here puts them in this page's injector (they reach its AlertRulesStore). */
  private readonly viewContainerRef = inject(ViewContainerRef);

  protected readonly metricOf = metricOf;
  protected readonly formatThreshold = formatThreshold;
  protected readonly describeRule = describeRule;
  /** The Edit/Delete column only for those who may use it. */
  protected readonly columns = computed(() =>
    this.canEdit()
      ? ['metric', 'comparison', 'threshold', 'level', 'enabled', 'actions']
      : ['metric', 'comparison', 'threshold', 'level', 'enabled'],
  );
  /** The rules, 25 per page (Material paginator). */
  protected readonly paging = paginate(this.store.rules, 25);
  protected readonly trackById = (_: number, rule: AlertConfig) => rule.id;

  /** Last outcome, announced politely ("Rule added: …"). */
  protected readonly notice = signal('');
  /** A failed enable/disable (announced assertively; the toggle is rolled back). */
  protected readonly toggleError = signal<string | null>(null);
  /**
   * Enable/disable requests in flight: rule id → the state asked for. Shown instead of the
   * loaded state (optimistic) and disables that rule's toggle until the request ends.
   */
  private readonly pending = signal<ReadonlyMap<string, boolean>>(new Map());

  /** The state a rule's toggle shows: the one asked for while its request runs, else the loaded one. */
  protected isEnabled(rule: AlertConfig): boolean {
    return this.pending().get(rule.id) ?? rule.enabled;
  }

  protected isPending(rule: AlertConfig): boolean {
    return this.pending().has(rule.id);
  }

  /** The toggle's accessible name: what switching it does ("Disable Gearbox temperature above 100 °C"). */
  protected toggleLabel(rule: AlertConfig): string {
    return `${this.isEnabled(rule) ? 'Disable' : 'Enable'} ${describeRule(rule)}`;
  }

  /**
   * Switches a rule on or off: shown at once, PATCH `enabled`, then the store shows the API's
   * answer (and reloads; `alert-config.changed` reloads it too). A failure restores the loaded
   * state and says why.
   */
  protected setEnabled(rule: AlertConfig, enabled: boolean): void {
    if (this.isPending(rule)) return;
    this.toggleError.set(null);
    this.pending.update((p) => new Map(p).set(rule.id, enabled));
    const settle = () =>
      this.pending.update((p) => {
        const next = new Map(p);
        next.delete(rule.id);
        return next;
      });
    this.api
      .setEnabled(rule.id, enabled)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.store.replace(updated);
          settle();
          this.notice.set(`Rule ${enabled ? 'enabled' : 'disabled'}: ${describeRule(rule)}.`);
          this.reload();
        },
        error: (e: unknown) => {
          settle();
          this.toggleError.set(toggleErrorMessage(e, enabled, rule));
          this.reload(); // e.g. deleted or changed elsewhere: show the rules as they are
        },
      });
  }

  protected reload(): void {
    this.store.reload();
  }

  protected openAdd(): void {
    this.openEditor(null);
  }

  protected openEdit(rule: AlertConfig): void {
    this.openEditor(rule);
  }

  private openEditor(rule: AlertConfig | null): void {
    this.dialog
      .open<RuleEditorDialog, RuleEditorData, RuleEditorResult>(RuleEditorDialog, {
        ...DIALOG_CONFIG,
        viewContainerRef: this.viewContainerRef,
        data: { rule },
      })
      .afterClosed()
      .subscribe((result) => {
        if (!result) return; // cancelled (Esc, Cancel)
        this.notice.set(`Rule ${result.action}: ${describeRule(result.rule)}.`);
        this.reload();
      });
  }

  protected confirmDelete(rule: AlertConfig): void {
    this.dialog
      .open<DeleteRuleDialog, AlertConfig, DeleteRuleResult>(DeleteRuleDialog, {
        ...DIALOG_CONFIG,
        viewContainerRef: this.viewContainerRef,
        data: rule,
      })
      .afterClosed()
      .subscribe((result) => {
        if (!result) return;
        this.notice.set(`Rule ${result}: ${describeRule(rule)}.`);
        this.reload();
      });
  }
}
