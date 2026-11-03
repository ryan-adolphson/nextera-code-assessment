import { Component, input } from '@angular/core';
import { MatTabLink, MatTabNav, MatTabNavPanel } from '@angular/material/tabs';
import { RouterLink, RouterLinkActive } from '@angular/router';

/** One routed tab: `id` is the `<section>-tab-<id>` test hook. */
export interface PageTab {
  readonly id: string;
  readonly label: string;
  /** `routerLink` commands or an absolute URL. */
  readonly link: string | readonly string[];
  /** Match the URL exactly (a tab whose path prefixes its siblings', like a farm's Overview). */
  readonly exact?: boolean;
}

/**
 * Routed section tabs: a Material tab nav bar (`mat-tab-nav-bar` + `mat-tab-link`) whose links are
 * router links, and a `mat-tab-nav-panel` around the page's content (projected). Each tab is its
 * own route; the active link follows `routerLinkActive`.
 *
 * ARIA (Material's tabs pattern, because `[tabPanel]` is set): the `<nav>` is `role="tablist"`
 * named by `label`, each link is `role="tab"` with `aria-selected` and `aria-controls` → the panel,
 * the panel is `role="tabpanel"` labelled by the active tab. One tab stop (the active tab; arrow
 * keys, Home and End move between the tabs, Enter or Space follows the link). No `aria-current`.
 * On a narrow screen Material scrolls the links and shows its paginator arrows instead of wrapping.
 *
 * ```html
 * <app-page-tabs section="alerting" label="Alerting" [tabs]="tabs">…the page below the tabs…</app-page-tabs>
 * ```
 *
 * `fill`: on a window-high page (a flex column with a `TableFrame`), the host and the panel are
 * flex columns too, so the frame still gets the height left in the window.
 */
@Component({
  selector: 'app-page-tabs',
  imports: [MatTabNav, MatTabLink, MatTabNavPanel, RouterLink, RouterLinkActive],
  host: { '[class]': "fill() ? 'flex min-h-0 flex-1 flex-col' : 'block'" },
  template: `
    <nav
      mat-tab-nav-bar
      mat-stretch-tabs="false"
      class="mt-4"
      [tabPanel]="panel"
      [attr.aria-label]="label()"
      [attr.data-testid]="section() + '-tabs'"
    >
      @for (tab of tabs(); track tab.id) {
        <a
          mat-tab-link
          [routerLink]="tab.link"
          routerLinkActive
          #rla="routerLinkActive"
          [routerLinkActiveOptions]="{ exact: !!tab.exact }"
          [active]="rla.isActive"
          [attr.data-testid]="section() + '-tab-' + tab.id"
          >{{ tab.label }}</a
        >
      }
    </nav>
    <mat-tab-nav-panel
      #panel
      [class]="fill() ? 'flex min-h-0 flex-1 flex-col' : 'block'"
      [attr.data-testid]="section() + '-tab-panel'"
    >
      <ng-content />
    </mat-tab-nav-panel>
  `,
})
export class PageTabs {
  /** Test-hook prefix: `<section>-tabs`, `<section>-tab-<id>`, `<section>-tab-panel`. */
  readonly section = input.required<string>();
  /** Accessible name of the tab list, e.g. "Alerting". */
  readonly label = input.required<string>();
  readonly tabs = input.required<readonly PageTab[]>();
  /** Keep the flex-column chain of a window-high page (see above). */
  readonly fill = input(false);
}
