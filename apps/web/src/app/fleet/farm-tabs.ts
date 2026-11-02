import { Component, computed, input } from '@angular/core';
import { PageTab, PageTabs } from '../ui/page-tabs';

/** A farm's tabs, in order. `id` is the `farm-tab-<id>` test hook; `path` is under /farms/:farmId. */
export const FARM_TABS = [
  { id: 'overview', path: '', label: 'Overview', exact: true },
  { id: 'history', path: 'history', label: 'History', exact: false },
  { id: 'weather', path: 'weather', label: 'Weather history', exact: false },
] as const;

/**
 * A farm's routed tabs (`PageTabs`: Material tab nav bar, tablist "Farm"); the farm page below
 * them is projected into the tab panel. Overview matches exactly (/farms/:farmId), so it isn't
 * active on /farms/:farmId/history or /weather.
 */
@Component({
  selector: 'app-farm-tabs',
  imports: [PageTabs],
  host: { class: 'block' },
  template: `
    <app-page-tabs section="farm" label="Farm" [tabs]="tabs()">
      <ng-content />
    </app-page-tabs>
  `,
})
export class FarmTabs {
  readonly farmId = input.required<string>();

  protected readonly tabs = computed<PageTab[]>(() =>
    FARM_TABS.map((tab) => ({
      id: tab.id,
      label: tab.label,
      exact: tab.exact,
      link: ['/farms', this.farmId(), ...(tab.path ? [tab.path] : [])],
    })),
  );
}
