import { Component, booleanAttribute, input } from '@angular/core';
import { PageTab, PageTabs } from '../ui/page-tabs';

/** The Alerting section's tabs, in order. `id` is the `alerting-tab-<id>` test hook. */
export const ALERTING_TABS = [
  { id: 'history', link: '/alerting/history', label: 'History' },
  { id: 'rules', link: '/alerting/rules', label: 'Rules' },
] as const satisfies readonly PageTab[];

/**
 * The Alerting pages' routed tabs (`PageTabs`: Material tab nav bar, tablist "Alerting"); the page
 * below them is projected into the tab panel. The side nav's Alerting item stays current on both.
 */
@Component({
  selector: 'app-alerting-tabs',
  imports: [PageTabs],
  host: { '[class]': "fill() ? 'flex min-h-0 flex-1 flex-col' : 'block'" },
  template: `
    <app-page-tabs section="alerting" label="Alerting" [tabs]="tabs" [fill]="fill()">
      <ng-content />
    </app-page-tabs>
  `,
})
export class AlertingTabs {
  /** On a window-high page (History), keep its flex-column chain (see `PageTabs`). */
  readonly fill = input(false, { transform: booleanAttribute });
  protected readonly tabs = ALERTING_TABS;
}
