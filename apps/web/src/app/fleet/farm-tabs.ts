import { Component, computed, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

/** A farm's tabs, in order. `id` is the `farm-tab-<id>` test hook; `path` is under /farms/:farmId. */
export const FARM_TABS = [
  { id: 'overview', path: '', label: 'Overview', exact: true },
  { id: 'weather', path: 'weather', label: 'Weather history', exact: false },
] as const;

/**
 * Tab-style links between a farm's pages (like the Alerting tabs): each tab is its own route, so
 * this is a navigation landmark with `aria-current="page"`, not an ARIA tablist. Overview matches
 * exactly (/farms/:farmId), so it isn't current on /farms/:farmId/weather.
 */
@Component({
  selector: 'app-farm-tabs',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav aria-label="Farm" class="mt-4 border-b border-line" data-testid="farm-tabs">
      <ul class="-mb-px flex gap-1">
        @for (tab of tabs(); track tab.id) {
          <li>
            <a
              class="inline-block border-b-2 border-transparent px-4 py-2 font-medium text-muted no-underline hover:text-ink hover:no-underline aria-[current=page]:border-accent aria-[current=page]:text-ink"
              [routerLink]="tab.link"
              routerLinkActive
              [routerLinkActiveOptions]="{ exact: tab.exact }"
              ariaCurrentWhenActive="page"
              [attr.data-testid]="'farm-tab-' + tab.id"
              >{{ tab.label }}</a
            >
          </li>
        }
      </ul>
    </nav>
  `,
})
export class FarmTabs {
  readonly farmId = input.required<string>();

  protected readonly tabs = computed(() =>
    FARM_TABS.map((tab) => ({
      ...tab,
      link: ['/farms', this.farmId(), ...(tab.path ? [tab.path] : [])],
    })),
  );
}
