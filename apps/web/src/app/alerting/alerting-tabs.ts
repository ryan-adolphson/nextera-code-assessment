import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

/** The Alerting section's tabs, in order. `id` is the `alerting-tab-<id>` test hook. */
export const ALERTING_TABS = [
  { id: 'history', path: '/alerting/history', label: 'History', exact: false },
  { id: 'rules', path: '/alerting/rules', label: 'Rules', exact: false },
] as const;

/**
 * Tab-style links between the Alerting pages. They are page links (each tab is its own route), so
 * this is a navigation landmark with `aria-current="page"`, not an ARIA tablist; the side nav's
 * Alerting item stays current on both.
 */
@Component({
  selector: 'app-alerting-tabs',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav aria-label="Alerting" class="mt-4 border-b border-line" data-testid="alerting-tabs">
      <ul class="-mb-px flex gap-1">
        @for (tab of tabs; track tab.id) {
          <li>
            <a
              class="inline-block border-b-2 border-transparent px-4 py-2 font-medium text-muted no-underline hover:text-ink hover:no-underline aria-[current=page]:border-accent aria-[current=page]:text-ink"
              [routerLink]="tab.path"
              routerLinkActive
              [routerLinkActiveOptions]="{ exact: tab.exact }"
              ariaCurrentWhenActive="page"
              [attr.data-testid]="'alerting-tab-' + tab.id"
              >{{ tab.label }}</a
            >
          </li>
        }
      </ul>
    </nav>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AlertingTabs {
  protected readonly tabs = ALERTING_TABS;
}
