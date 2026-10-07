import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AlertLevel, levelLabel } from './alert-config.model';

/**
 * An alert level as a small pill: "Info" (neutral, accent dot), "Warning" (solid --warn with
 * --on-warn text) or "Error" (solid --danger with --on-danger text): WCAG AA in both themes, and
 * the text always names the level. With a `count`, the pill reads "Error: 3". Test hooks: `data-testid` (default "alert-level") + `data-level`.
 */
@Component({
  selector: 'app-alert-level-badge',
  host: {
    class:
      'inline-flex items-center gap-1.5 rounded-full bg-surface px-2 py-0.5 text-xs font-medium whitespace-nowrap text-ink data-[level=error]:bg-danger data-[level=error]:text-on-danger data-[level=warn]:bg-warn data-[level=warn]:text-on-warn',
    '[attr.data-testid]': 'testId()',
    '[attr.data-level]': 'level()',
  },
  template: `
    @if (level() === 'info') {
      <span class="size-2 rounded-full bg-accent" aria-hidden="true"></span>
    }
    {{ label() }}{{ count() === null ? '' : ': ' + count() }}
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertLevelBadge {
  readonly level = input.required<AlertLevel>();
  readonly testId = input('alert-level');
  /** Shown after the level ("Error: 3"); none by default. */
  readonly count = input<number | null>(null);
  protected readonly label = computed(() => levelLabel(this.level()));
}
