# Navigation and layout (Material 22.2)

Verified against `material/types/{tabs,sidenav,toolbar,list,expansion,divider}.d.ts`, `cdk/types/{layout,accordion}.d.ts` and the 22.2.x docs sources (`tabs.md`, `sidenav.md`).

The app's side navigation is **not** Material (a custom side nav in `FleetShell`, expandable table rows instead of expansion panels); section tabs **are** Material (a routed tab nav bar). This file says what the repo uses, what Material offers, and when Material would be the right call.

## Section tabs: `PageTabs`, a routed `mat-tab-nav-bar` (used)

Every section's tab strip goes through one shared component, `PageTabs` (`ui/page-tabs.ts`); the section wrappers only hold the tab list and the test-hook prefix:

| Wrapper | Tabs (`<section>-tab-<id>`) | Used by |
|---|---|---|
| `FarmTabs` (`fleet/farm-tabs.ts`, `FARM_TABS`), inside `FarmHeader` | `farm`: Overview (`exact`), History, Weather history | farm page, farm History, Weather history |
| `AlertingTabs` (`alerting/alerting-tabs.ts`, `ALERTING_TABS`) | `alerting`: History, Rules | Alerting History (`fill`), Rules |
| `UnallocatedTabs` (`unallocated/unallocated-tabs.ts`, `UNALLOCATED_TABS`) | `unallocated`: Pending, Blocked | the two Unallocated pages (owner+) |

```html
<!-- ui/page-tabs.ts -->
<nav mat-tab-nav-bar mat-stretch-tabs="false" class="mt-4" [tabPanel]="panel"
     [attr.aria-label]="label()" [attr.data-testid]="section() + '-tabs'">
  @for (tab of tabs(); track tab.id) {
    <a mat-tab-link [routerLink]="tab.link" routerLinkActive #rla="routerLinkActive"
       [routerLinkActiveOptions]="{ exact: !!tab.exact }" [active]="rla.isActive"
       [attr.data-testid]="section() + '-tab-' + tab.id">{{ tab.label }}</a>
  }
</nav>
<mat-tab-nav-panel #panel [class]="fill() ? 'flex min-h-0 flex-1 flex-col' : 'block'"
                   [attr.data-testid]="section() + '-tab-panel'"><ng-content /></mat-tab-nav-panel>

<!-- a page: the content below the tabs goes inside, so it lands in the tab panel -->
<h1>Alerting</h1>
<app-alerting-tabs>…the page…</app-alerting-tabs>
<app-farm-header [farm]="farm">…the farm page…</app-farm-header>
```

- **The panel wraps the page, not a `<router-outlet>`:** the tab routes are siblings (each page renders its own header and tabs; the farm turbine page has none), so each page projects its body into the panel. Add a tab by adding a row to the section's `*_TABS`; add a section with a new wrapper (`section`, `label`, tabs) and wrap that section's page bodies.
- **`[tabPanel]` is required:** `MatTabNav.ngAfterViewInit` throws in dev mode without it ("A mat-tab-nav-panel must be specified via [tabPanel]").
- **Active link:** `[active]="rla.isActive"` from `routerLinkActive` (`exact` for a tab whose path prefixes its siblings', the farm Overview). Never add `ariaCurrentWhenActive` to a `mat-tab-link`: Material binds `aria-current` itself (null when a panel is set) and the two would fight.
- **`mat-stretch-tabs="false"`:** left-aligned tabs sized to their labels (the default stretches them over the width).
- **`fill`** (Alerting History, a window-high page with a `TableFrame`): the wrapper host and the panel are flex columns, so the frame still gets the height left in the window. `mat-tab-nav-panel` has no display of its own (an inline custom element), hence `block` otherwise; no other utilities on the Material hosts (the bar is `display: flex` from Material).
- **Narrow screens:** Material measures the links and, when they overflow, shows its paginator arrows (mouse/touch only, not focusable) and scrolls the list; the links never wrap. Keyboard focus scrolls the focused link into view.

**ARIA with `[tabPanel]`** (verified in `fesm2022/tabs.mjs`): the `<nav>` host gets `role="tablist"` (allowed on `nav`; its `aria-label` names the tablist, so it is no longer a navigation landmark); each `mat-tab-link` gets `role="tab"`, `aria-selected="true|false"`, `aria-controls` = the panel id, an `mat-tab-link-N` id and a roving `tabindex` (0 on the selected/focused link, −1 on the others); the panel is `role="tabpanel"` with `aria-labelledby` = the active link's id. No `aria-current`. Without `[tabPanel]` Material would instead leave the nav a landmark and set `aria-current="page"` on the active link, but 22.2 throws in dev mode then, so that variant isn't available.

**Keyboard:** one tab stop (the selected tab); Left/Right arrows move focus (wrapping), Home/End jump to the first/last; Enter or Space follows the focused link (manual activation: focus alone doesn't navigate). Focus isn't kept across the navigation (the new page renders a new bar); Tab lands on the newly selected tab.

**Theming:** `--mat-tab-*` in `styles.css` (theming-tokens.md): 40px links, weight 500, `--muted` inactive / `--text` active, hover and focus labels, 2px `--accent` indicator, `--border` divider, `--text` paginator arrows. Keyboard focus shows Material's 12% state layer behind the link and the label turns `--text`; there is no focus ring (`--mat-focus-indicator-display` is unset app-wide).

**Specs:** `MatTabNavBarHarness.with({ selector: '[data-testid=farm-tabs]' })` → `getLinks`, `getActiveLink`, `clickLink({ label })`, `getPanel`; ARIA via `aria-selected`/`role`/`aria-controls`/`aria-labelledby`; keys via `(await link.host()).sendKeys(TestKey.RIGHT_ARROW)` (Space: `sendKeys(' ')`). Look the bar up again after each navigation. `fleet/farm-tabs.spec.ts` has the full set (labels, active link, ARIA, arrows/Home/End/Enter/Space). Playwright: `getByRole('tablist', { name: 'Farm' })`, `getByRole('tab', { name: 'History' })`, `toHaveAttribute('aria-selected', 'true')`.

## Material tabs: the rest of the API

| Component | Selector | Notes |
|---|---|---|
| `MatTabNav` (used) | `[mat-tab-nav-bar]` (export `matTabNavBar`, `matTabNav`) | inputs `tabPanel`, `mat-stretch-tabs`, `fitInkBarToContent`, `animationDuration`, `backgroundColor`, `color`, `disableRipple`; `disablePagination` (from the paginated header); `updateActiveLink()` |
| `MatTabLink` (used) | `[mat-tab-link]`, `[matTabLink]` (export `matTabLink`) | `active`, `disabled`, `disableRipple`, `tabIndex`, `id` |
| `MatTabNavPanel` (used) | `mat-tab-nav-panel` (export `matTabNavPanel`) | `id`; host `role="tabpanel"`, `aria-labelledby` = the active link |
| `MatTabGroup` (not used) | `mat-tab-group` (export `matTabGroup`) | views **within one route**. Inputs: `selectedIndex`, `dynamicHeight`, `animationDuration`, `preserveContent`, `headerPosition`, `fitInkBarToContent`, `mat-stretch-tabs`, `mat-align-tabs`, `disablePagination`, `contentTabIndex`, `disableRipple`, `aria-label`, `aria-labelledby`. Outputs: `selectedIndexChange`, `selectedTabChange`, `focusChange`, `animationDone`. |
| `MatTab` (not used) | `mat-tab` | `label`, `labelClass`, `bodyClass`, `disabled`, `aria-label`; lazy body `<ng-template matTabContent>`; custom label `<ng-template mat-tab-label>` |

Use `mat-tab-group` only if a page ever needs in-page views that are not separate URLs (none today). All `--mat-tab-*` tokens (from the compiled styles): `active-indicator-color|height|shape`, `active-(hover|focus)-indicator-color`, `(active|inactive)-label-text-color`, `(active|inactive)-(hover|focus)-label-text-color`, `(active|inactive|disabled)-ripple-color`, `divider-color|height`, `container-height`, `label-text-font|size|weight|line-height|tracking`, `pagination-icon-color`, `background-color`/`foreground-color` (only with `backgroundColor`), `header-animation-duration`, `body-animation-duration` (tab group). Harnesses: `MatTabNavBarHarness`, `MatTabLinkHarness` (above), `MatTabGroupHarness` (`getTabs`, `getSelectedTab`, `selectTab`), `MatTabHarness` (`getLabel`, `isSelected`, `select`, `getTextContent`).

## Side navigation: `FleetShell` (used)

`fleet/fleet-shell.html`: `<nav id="main-nav" aria-label="Main">` with `routerLink` + `routerLinkActive` + `ariaCurrentWhenActive="page"`, styled with `aria-[current=page]:` (accent left border).
- Desktop (`md`+): a sticky left column (`md:w-56`, `md:h-dvh`).
- Narrower: a top bar with a menu button (`aria-controls="main-nav"`, `aria-expanded`); the nav is `hidden data-open:block md:block`. Don't use the `hidden` attribute (preflight's `display: none !important` beats `md:block`). Esc closes it and refocuses the button; any `NavigationEnd` closes it.
- The menu expands **inline**, not as an overlay drawer, so Leaflet's z-indexed panes never cover it.
- "Skip to content" link first, `<main id="content" class="min-w-0">` so wide tables scroll inside their wrapper.

### `mat-sidenav` / `mat-drawer` (not used)

`mat-sidenav-container` > `mat-sidenav` + `mat-sidenav-content` (or the `mat-drawer*` equivalents). `mat-sidenav`/`mat-drawer` inputs: `mode` (`'over' | 'push' | 'side'`), `opened`, `position` (`'start' | 'end'`), `disableClose`, `autoFocus`, `fixedInViewport`, `fixedTopGap`, `fixedBottomGap`; outputs `openedChange`, `opened`, `closed`, `openedStart`, `closedStart`. Container: `autosize`, `hasBackdrop`; output `backdropClick`. In `over`/`push` mode it traps focus and closes on Esc. Reconsider only if the shell needs an overlay drawer; it would have to sit above Leaflet panes (z-index) and keep the current tests' hooks. Tokens `--mat-sidenav-*`.

## Toolbar, list, divider (not used)

- `mat-toolbar` (+ `mat-toolbar-row`): a styled header bar, no ARIA semantics of its own. Our top bar is plain markup. Tokens `--mat-toolbar-*`.
- Lists: `mat-list` / `mat-nav-list` / `mat-action-list` / `mat-selection-list`, items `mat-list-item` (`a[mat-list-item]`, `button[mat-list-item]`; `activated`), parts `[matListItemTitle]`, `[matListItemLine]`, `[matListItemIcon]`, `[matListItemAvatar]`, `[matListItemMeta]`, `mat-list-option`. A `mat-nav-list` could host nav links, but the shell's list is plain `<ul>` with Tailwind. Tokens `--mat-list-*`.
- `mat-divider` (`vertical`, `inset`): we use `border-line` utilities. Tokens `--mat-divider-color`, `--mat-divider-width`.

## Expansion panels (not used)

`mat-accordion` (`multi` from `CdkAccordion`, `displayMode` `'default' | 'flat'`, `togglePosition` `'before' | 'after'`, `hideToggle`) > `mat-expansion-panel` (`expanded`, `disabled`, `hideToggle`, `togglePosition`; outputs `opened`, `closed`, `expandedChange`, `afterExpand`, `afterCollapse`) > `mat-expansion-panel-header` (`mat-panel-title`, `mat-panel-description`), lazy body `ng-template[matExpansionPanelContent]`, `mat-action-row`. The header is a `role="button"` with `aria-expanded`/`aria-controls`.

The repo's expandable content is table rows (tables.md, Expandable rows), with the same ARIA done by hand on a real `<button>`. Use `mat-expansion-panel` for collapsible **sections** of a page (settings groups, FAQ-like blocks), not for table rows. Harnesses: `MatAccordionHarness`, `MatExpansionPanelHarness` (`expand`, `collapse`, `toggle`, `isExpanded`, `getTitle`, `getTextContent`).

## Responsive layout

- **CSS first:** Tailwind breakpoints (`sm:`, `md:`…) for layout. `BreakpointObserver` would duplicate them in JS.
- **Logic only:** if behaviour (not styling) depends on the viewport, inject `BreakpointObserver` (`@angular/cdk/layout`): `observe(query | query[])` → `Observable<BreakpointState>` (`matches`, `breakpoints`), `isMatched(query)`. Presets in `Breakpoints` (`XSmall`, `Small`, `Medium`, `Large`, `XLarge`, `Handset`, `Tablet`, `Web`, and the `*Portrait`/`*Landscape` variants) are Material's breakpoints, not Tailwind's: pass the same media query as the Tailwind breakpoint (`'(min-width: 48rem)'` for `md`) to stay consistent, and convert with `toSignal`.
- jsdom has no media queries that match by width; tests of breakpoint logic need a stubbed `MediaMatcher`.

## Pitfalls

- Section tabs are always `PageTabs`: don't hand-roll a tab strip of links, and don't put `aria-current` on a tab (the tablist says which one is selected).
- `[routerLinkActiveOptions]="{ exact: true }"` for a tab whose path is a prefix of its siblings (the farm Overview tab).
- Everything below the tabs belongs in the panel (`<app-…-tabs>…</app-…-tabs>`), or `aria-controls` points at a panel that doesn't hold the page.
- Pages inside the shell must not add their own `<main>`; use `<section aria-label>` or headings.
