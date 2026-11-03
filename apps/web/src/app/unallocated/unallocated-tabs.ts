import { Component } from '@angular/core';
import { PageTab, PageTabs } from '../ui/page-tabs';

/** The Unallocated section's tabs, in order. `id` is the `unallocated-tab-<id>` test hook. */
export const UNALLOCATED_TABS = [
  { id: 'pending', link: '/unallocated/pending', label: 'Pending' },
  { id: 'blocked', link: '/unallocated/blocked', label: 'Blocked' },
] as const satisfies readonly PageTab[];

/**
 * The Unallocated pages' routed tabs (`PageTabs`: Material tab nav bar, tablist "Unallocated");
 * the page below them is projected into the tab panel.
 */
@Component({
  selector: 'app-unallocated-tabs',
  imports: [PageTabs],
  host: { class: 'block' },
  template: `
    <app-page-tabs section="unallocated" label="Unallocated" [tabs]="tabs">
      <ng-content />
    </app-page-tabs>
  `,
})
export class UnallocatedTabs {
  protected readonly tabs = UNALLOCATED_TABS;
}
