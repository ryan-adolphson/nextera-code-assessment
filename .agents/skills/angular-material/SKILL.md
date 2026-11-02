---
name: angular-material
description: Angular Material 22.2 and Angular CDK 22.2 in this repo's web app (apps/web) - form fields, matInput and native matNativeControl selects, autocomplete, datepicker and date range, slide-toggle, buttons (matButton/matIconButton, danger-button), button-toggle groups, chips, icons (svgIcon via provideIcons), mat-table with sort and paginator (TABLE_IMPORTS, [appPaging], TableFrame), routed section tabs (mat-tab-nav-bar + mat-tab-link + mat-tab-nav-panel via PageTabs), MatDialog, matTooltip, Signal Forms interop ([formField], error state), theming through --mat-sys-* and --mat-<component>-* tokens in styles.css with no Material theme, CDK a11y/overlay/layout, and Material test harnesses. Use when building, changing, reviewing or testing any Material/CDK UI in apps/web, when choosing which Material component fits a need, or when looking up a v22.2 selector, input, token name or harness method.
---

# Angular Material 22.2 in this repo

Installed: `@angular/material` and `@angular/cdk` **22.2.2**, `@angular/core`/`@angular/forms` 22.2.1 (check `apps/web/node_modules/@angular/material/package.json` before relying on a version-specific API). The app is zoneless, signal-based and standalone, styled with **Tailwind v4 on CSS theme tokens**, and has **no Material theme**: Material reads `--mat-sys-*` and `--mat-<component>-*` CSS variables that `apps/web/src/styles.css` points at our tokens.

Everything in this skill was checked against the installed `.d.ts` files, the compiled styles in `fesm2022/*.mjs` and the docs sources of the `22.2.x` branch (`angular/components`, which material.angular.dev renders). No API in it is marked experimental or developer preview in 22.2 (the only `@experimental` export nearby is Signal Forms' `provideExperimentalWebMcpForms`: don't use it). If you need something not covered here, verify it the same way (see **Verifying an API**) before writing it.

## When to use

- Building or changing any UI in `apps/web` that uses, or could use, a Material component or a CDK utility.
- Choosing a component for a need (see **Decision guide**), including the ones the repo deliberately doesn't use.
- Theming: adding or changing a `--mat-*` token, dark mode, density, contrast.
- Writing specs for Material UI: harnesses, overlays in jsdom, zoneless timing.
- Reviewing a diff for Material accessibility, token use and the repo conventions below.

## Repo rules (they win over the general docs)

1. **No Material theme, no component CSS.** No `mat.theme()`, no prebuilt theme, no `styles:`/`styleUrl`. Theme only by setting `--mat-sys-*` (system) and `--mat-<component>-*` (component) variables in `src/styles.css`, mapped to our tokens (`var(--accent)`, `var(--surface)`…), so light/dark follows `prefers-color-scheme` for free. The official docs prefer the Sass `overrides` mixins (they validate names); we have no Sass build, so **verify every token name** against the installed package (command in `references/theming-tokens.md`).
2. **Material's styles are unlayered; Tailwind utilities are in `@layer utilities`.** Unlayered CSS wins, so where Material sets the same property use the `!` form: `size-5!`, `text-muted!`, `text-right!` on a `mat-cell`.
3. **No Tailwind `display` utilities on a Material host** (`grid`/`flex` on `mat-dialog-content`, `mat-form-field`, `mat-chip-set`…): Material's own `display: block` wins and the layout silently collapses. Lay out in an inner `<div>`.
4. **Buttons:** `matButton="filled"` (primary), `matButton="outlined"` (secondary), `matButton` (text), `matIconButton` (with `aria-label`), `class="danger-button"` for destructive ones. Never the legacy `mat-raised-button`/`mat-flat-button`/`mat-stroked-button` selectors. A template ref on a Material button resolves to the component: `viewChild('ref', { read: ElementRef })` for the element.
5. **Selects are native:** `<select matNativeControl>` inside an outline `mat-form-field`, not `mat-select`. Bind `[selected]` on each `@for` option, not `[value]` on the `<select>`. Specs set `.value` and dispatch `input` (Signal Forms listens to it) and `change`.
6. **Forms are Signal Forms** (`@angular/forms/signals`, stable in 22): `form()` over a private model signal, `[formField]` on the Material control, `[formRoot]` on the `<form>`. No Reactive Forms. Material 22.2 reads the bound field: its default error state is **invalid and touched** (no "submitted"), so a submit must mark fields touched (`submit()` does; a plain `(submit)` handler calls `form().markAsTouched()` when invalid).
7. **Form fields:** `appearance="outline" subscriptSizing="dynamic"` + `<mat-label>`; filters add `floatLabel="always"` so placeholders show; units go in `<span matTextSuffix>`.
8. **Icons** are `<mat-icon svgIcon="…">` from `ICONS` in `src/app/ui/icons.ts`, registered once by `provideIcons()` (app config and `openFleet`). No icon font, no HTTP icons, no ligature text. `mat-icon` is `aria-hidden="true"` by default: pair it with `sr-only` text or put the name on the button.
9. **Tables:** `<table mat-table>` (native table, so specs keep `tbody tr`/`td`), spread `TABLE_IMPORTS` (`src/app/ui/table.ts`) into `imports`, `[trackBy]` by id, row hooks on `<tr mat-row>`, pagination client-side from signals with `paginate()` + `<mat-paginator [appPaging]>` (`ui/paging.ts`), window-high pages wrap the table in `<app-table-frame>` (`ui/table-frame.ts`). No `MatTableDataSource`.
10. **Dialogs** are `MatDialog` components with `mat-dialog-title`/`-content`/`-actions`, opened with the shared config (`width: '32rem'`, `maxWidth: 'calc(100vw - 2rem)'`, `autoFocus: 'first-tabbable'`, `ariaModal: true`) plus the page's `viewContainerRef` so the dialog sees page-provided stores. Writes happen inside the dialog, which closes with a result only on success.
11. **Status messages are in-page live regions** (`role="status"` notice, `role="alert"` error), not snack-bars. Tooltips sit on a real `<button type="button">` and open on click too (`#tip="matTooltip" (click)="tip.show()"`).
12. **Section tabs are a routed Material tab nav bar** through the shared `PageTabs` (`ui/page-tabs.ts`): `nav[mat-tab-nav-bar]` with `[tabPanel]`, `a[mat-tab-link]` + `routerLink` + `#rla="routerLinkActive"` + `[active]="rla.isActive"`, and the page's content projected into `mat-tab-nav-panel` (the section wrappers `FarmTabs`/`FarmHeader`, `AlertingTabs`, `UnallocatedTabs` wrap the page body). ARIA is the tabs pattern (`tablist`/`tab`/`aria-selected`/`tabpanel`), never `aria-current` on the tabs; no `ariaCurrentWhenActive` on a `mat-tab-link`. Not `mat-tab-group` (in-page views).
13. **Test hooks:** `data-testid` and state `data-*` attributes, never utility or `mat-mdc-*` classes (exception: harness host selectors and the documented `.cdk-overlay-container` query).
14. **`@defer` only local components:** to defer a Material component, wrap it in a local component (`alerting/alert-chips.ts` wraps `MatChip`/`MatChipSet`); deferring a package export pulls the whole package module into the initial chunk. Placeholders keep the rendered size.
15. **Stable APIs only; don't hand-roll** what Material or the CDK provides (focus trap, overlay, live announcer, breakpoints, `aria-describedby` wiring).

## Decision guide

| Need | Use | Reference |
|---|---|---|
| Text, number, search, date text input | `mat-form-field` + `input matInput` | form-fields |
| Pick one of a short, fixed list | `mat-form-field` + `select matNativeControl` | form-fields |
| Pick one of a long or searchable list (farms, turbines) | `input matInput [matAutocomplete]` + `mat-autocomplete` (+ `mat-optgroup`) and a validator that rejects free text | form-fields |
| A day range | `mat-date-range-input` + `matStartDate`/`matEndDate` + `mat-date-range-picker`, `provideNativeDateAdapter()` in the page | form-fields |
| On/off setting | `mat-slide-toggle` (`role="switch"`) | form-fields |
| One of 2–5 mutually exclusive views (range presets, UTC/local) | `mat-button-toggle-group` (radiogroup, `aria-checked`) | buttons-and-indicators |
| Action | `matButton` variants; icon-only: `matIconButton` + `aria-label` | buttons-and-indicators |
| Read-only labels in a list (triggered rules) | `mat-chip-set` + `mat-chip` | buttons-and-indicators |
| Status word or count pill | our own pill (`AlertLevelBadge`, `StalenessBadge`) | buttons-and-indicators |
| Data grid with sort/paging | `mat-table` + `mat-sort-header` + `mat-paginator [appPaging]` | tables |
| Row that expands to details | `multiTemplateDataRows` + detail `mat-row` with `[attr.hidden]` | tables |
| Modal task or confirmation | `MatDialog` | overlays |
| Extra info on hover/focus/tap | `matTooltip` on a `<button>` | overlays |
| Announce an outcome | in-page `role="status"` / `role="alert"`; `LiveAnnouncer` only when there is no visible text | overlays, cdk |
| Sections of one area that are separate routes | `PageTabs` (`mat-tab-nav-bar` + `[tabPanel]`, routed links) | navigation-and-layout |
| Focus trap / focus origin / tabbable checks outside a dialog | CDK a11y (`cdkTrapFocus`, `FocusMonitor`, `InteractivityChecker`) | cdk |
| Layout change by viewport | Tailwind breakpoints (`md:`); `BreakpointObserver` only for logic | navigation-and-layout, cdk |

**Deliberately not used** (don't introduce without a reason the coordinator agrees to):

| Not used | Instead | Why |
|---|---|---|
| `mat-select` | native `select matNativeControl` | the platform picker on phones, and specs drive a real `<select>` instead of an overlay; the paginator's page-size menu is the one `MatSelect` in the app (internal to `mat-paginator`) |
| `MatSnackBar` | `role="status"` notice / `role="alert"` error in the page | snack-bars never take focus and time out; our notices stay where the action happened and are easy to assert |
| `mat-tab-group` | `PageTabs` (routed `mat-tab-nav-bar`) | each tab is its own lazy route with a bookmarkable URL; `mat-tab-group` keeps views of one route in memory |
| `mat-sidenav`, `mat-toolbar` | `FleetShell`'s own nav (sticky column / inline menu) | inline expansion keeps Leaflet panes from covering an overlay drawer |
| `mat-expansion-panel` | expandable table rows | the expanding thing is a table row |
| `matBadge` | a pill element with `sr-only` text in the accessible name | `matBadge` exposes its content only through `aria-describedby` (`matBadgeDescription`) |
| `MatTableDataSource` | `paginate()` + `computed` sort/filter | state lives in signals |
| Reactive Forms, `ngModel` | Signal Forms | repo standard |
| Sass `mat.theme()`/`*-overrides` | plain `--mat-*` variables in `styles.css` | no Sass build; tokens follow our CSS variables |

## Verifying an API

```bash
cd apps/web/node_modules/@angular
# Selector, inputs (alias = template name) and outputs of a directive/component
grep -o 'Declaration<MatTooltip, .*' material/types/tooltip.d.ts
# A harness and its methods
grep -n 'class MatPaginatorHarness' -A40 material/types/paginator-testing.d.ts
# Is a token real? (every --mat-* the compiled components read)
grep -ohE 'var\(--mat-[a-z0-9-]+' material/fesm2022/*.mjs | sort -u | grep form-field-container
```

Typings live in `material/types/*.d.ts` (shared chunks are `_<name>-chunk.d.ts`), CDK in `cdk/types/`. The docs sources: `https://raw.githubusercontent.com/angular/components/22.2.x/src/material/<component>/<component>.md` (material.angular.dev is client-rendered, so WebFetch of it returns nothing). Where the docs and the typings disagree, the typings win (e.g. the dialog docs say `autoFocus: 'first-header'`; the type is `'first-heading'`).

## References

Load the one that matches the task (all under `references/`):

- [form-fields.md](references/form-fields.md): `mat-form-field`, `matInput`, native select, autocomplete, datepicker and date range, checkbox, radio, slide-toggle, Signal Forms interop and error state, `ErrorStateMatcher`.
- [buttons-and-indicators.md](references/buttons-and-indicators.md): `matButton` appearances, icon buttons, FABs, `disabledInteractive`, `showProgress`, button-toggle, chips, badge, progress bar/spinner, `mat-icon` and the icon registry.
- [tables.md](references/tables.md): `mat-table` on `<table>`, column/row defs, sticky rows, no-data row, expandable rows, `MatSort`, `MatPaginator`, `paginate()`/`PagingDirective`, `TableFrame`.
- [overlays.md](references/overlays.md): `MatDialog` (config, ref, directives, focus), `matTooltip`, `mat-menu`, `MatSnackBar` (and why not), CDK overlay basics.
- [navigation-and-layout.md](references/navigation-and-layout.md): routed section tabs (`PageTabs`: tab nav bar, ARIA, keyboard, tokens, specs), tab group, sidenav/drawer, toolbar, list, expansion, divider, `BreakpointObserver`.
- [theming-tokens.md](references/theming-tokens.md): how tokens resolve, system tokens, component tokens, finding a token name, the current `styles.css` mapping, scoped overrides, dark mode, density, focus indicators.
- [cdk.md](references/cdk.md): a11y (FocusTrap, FocusMonitor, LiveAnnouncer, InteractivityChecker, AriaDescriber, key managers), overlay, layout, clipboard, drag-drop, virtual scroll, text-field, platform, portal.
- [testing.md](references/testing.md): `TestbedHarnessEnvironment`, every harness used here with its methods, the jsdom/zoneless pitfalls already hit (overlay container, `keyCode` 27, `LayoutlessInteractivityChecker`, animations, resources and PendingTasks, `afterClosed` timing), and Playwright locators for Material controls.
