import {
  ChangeDetectionStrategy,
  Component,
  ViewContainerRef,
  inject,
  signal,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatDialog, MatDialogConfig } from '@angular/material/dialog';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { AlertConfig, describeRule, formatThreshold, metricOf } from './alert-config.model';
import { AlertLevelBadge } from './alert-level-badge';
import { AlertRulesStore } from './alert-rules.store';
import { AlertingTabs } from './alerting-tabs';
import { DeleteRuleDialog } from './delete-rule-dialog';
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
 * /alerting/rules: the alert thresholds, with add, edit and delete. The list is this page's
 * AlertRulesStore: reloaded after every write here and on `alert-config.changed` (any browser's
 * edits, over the shell's SSE stream). Adding, editing and deleting happen in Material dialogs
 * (`RuleEditorDialog`, `DeleteRuleDialog`), which do the write and keep errors inside; the page
 * announces the outcome and reloads.
 */
@Component({
  selector: 'app-alert-rules-page',
  // Its own rules store (only this page uses it); it follows the shell's FleetStore for
  // `alert-config.changed`.
  providers: [AlertRulesStore],
  imports: [AlertLevelBadge, AlertingTabs, MatButton, TABLE_IMPORTS],
  templateUrl: './alert-rules-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertRulesPage {
  protected readonly store = inject(AlertRulesStore);
  private readonly dialog = inject(MatDialog);
  /** Opening dialogs here puts them in this page's injector (they reach its AlertRulesStore). */
  private readonly viewContainerRef = inject(ViewContainerRef);

  protected readonly metricOf = metricOf;
  protected readonly formatThreshold = formatThreshold;
  protected readonly describeRule = describeRule;
  protected readonly columns = ['metric', 'comparison', 'threshold', 'level', 'actions'];
  /** The rules, 25 per page (Material paginator). */
  protected readonly paging = paginate(this.store.rules, 25);
  protected readonly trackById = (_: number, rule: AlertConfig) => rule.id;

  /** Last outcome, announced politely ("Rule added: …"). */
  protected readonly notice = signal('');

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
      .open<DeleteRuleDialog, AlertConfig, boolean>(DeleteRuleDialog, {
        ...DIALOG_CONFIG,
        viewContainerRef: this.viewContainerRef,
        data: rule,
      })
      .afterClosed()
      .subscribe((deleted) => {
        if (!deleted) return;
        this.notice.set(`Rule deleted: ${describeRule(rule)}.`);
        this.reload();
      });
  }
}
