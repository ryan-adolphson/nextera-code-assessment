import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

/** The Unallocated section's tabs, in order. `id` is the `unallocated-tab-<id>` test hook. */
export const UNALLOCATED_TABS = [
  { id: 'pending', path: '/unallocated/pending', label: 'Pending' },
  { id: 'blocked', path: '/unallocated/blocked', label: 'Blocked' },
] as const;

/**
 * Tab-style links between the Unallocated pages (like the Alerting tabs): page links with
 * `aria-current="page"` in a navigation landmark, not an ARIA tablist.
 */
@Component({
  selector: 'app-unallocated-tabs',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav aria-label="Unallocated" class="mt-4 border-b border-line" data-testid="unallocated-tabs">
      <ul class="-mb-px flex gap-1">
        @for (tab of tabs; track tab.id) {
          <li>
            <a
              class="inline-block border-b-2 border-transparent px-4 py-2 font-medium text-muted no-underline hover:text-ink hover:no-underline aria-[current=page]:border-accent aria-[current=page]:text-ink"
              [routerLink]="tab.path"
              routerLinkActive
              ariaCurrentWhenActive="page"
              [attr.data-testid]="'unallocated-tab-' + tab.id"
              >{{ tab.label }}</a
            >
          </li>
        }
      </ul>
    </nav>
  `,
})
export class UnallocatedTabs {
  protected readonly tabs = UNALLOCATED_TABS;
}
