# Theming with tokens, no Material theme (Material 22.2)

Verified against the compiled component styles in `material/fesm2022/*.mjs` (which `var(--mat-…)` each component reads, with which fallback), the token definitions in `material/<component>/_m3-<component>.scss`, the 22.2.x `guides/theming.md`, and `apps/web/src/styles.css`.

## How a token resolves

Every Material style reads a **component token** whose fallback is a **system token** or a literal:

```css
/* compiled into the button component's styles */
background-color: var(--mat-button-filled-container-color, var(--mat-sys-primary));
height: var(--mat-form-field-container-height, 56px);        /* form field */
background: var(--mat-table-background-color, var(--mat-sys-surface)); /* table */
```

So without any Material theme:
1. Setting a **system** token (`--mat-sys-primary: var(--accent)`) recolours every component that falls back to it.
2. Setting a **component** token (`--mat-button-filled-container-color: …`) overrides one component (or one instance, if set on a class or element).
3. Anything left unset uses Material's literal fallback (M3 defaults: 56px fields, 40px buttons, pill shapes).

Because our values are `var(--accent)`, `var(--surface)`… and those switch in the `prefers-color-scheme: dark` block, **dark mode needs nothing Material-specific**.

## Official API vs this repo

The docs (`guides/theming.md`) build a theme with `@include mat.theme((color, typography, density))`, override system tokens with `mat.theme-overrides((…))` and component tokens with `mat.<component>-overrides((…))` (e.g. `mat.card-overrides((elevated-container-color: red))`), and "strongly discourage" setting the CSS variables directly because the mixins validate names and survive renames.

This repo has **no Sass** (Tailwind v4 via PostCSS, plain `styles.css`), so it sets the same CSS variables directly. The cost is no name validation: a misspelt token silently does nothing. Mitigate it by checking every name (below) when you add or upgrade, and by keeping all `--mat-*` declarations in `styles.css` (global block or a named class), never in templates except Tailwind arbitrary properties for one-off sizes.

## Finding a token name

1. **What the installed components actually read** (the authority; 1046 names in 22.2.2):

   ```bash
   cd apps/web/node_modules/@angular/material
   grep -ohE 'var\(--mat-[a-z0-9-]+' fesm2022/*.mjs | sed 's/var(//' | sort -u | grep -- '--mat-slide-toggle-'   # one component's tokens
   grep -ohE 'var\(--mat-chip-label-text-color[^;"]*' fesm2022/chips.mjs | sort -u                               # with its fallback
   ```

2. **Where it is defined and what system token it defaults to:** `material/<component>/_m3-<component>.scss`, function `get-tokens()`: keys under `base`, `color`, `typography`, `density` (e.g. `form-field-container-height`, `button-filled-container-color: map.get($system, primary)`). The CSS variable is `--mat-` + the key. Density lists show the values per density step.
3. **Check every `--mat-*` the app sets is real** (bash/zsh; prints only unknown names, e.g. a typo like `--mat-form-feild-container-height`; 139 names, all real, at 22.2.2). Run it after adding tokens and after every Material upgrade:

   ```bash
   cd apps/web
   comm -23 \
     <(grep -rhoE -- '--mat-[a-z0-9]+(-[a-z0-9]+)+' src/styles.css src/app | sort -u) \
     <(grep -ohE 'var\(--mat-[a-z0-9-]+' node_modules/@angular/material/fesm2022/*.mjs | sed 's/var(//' | sort -u)
   ```

The component docs' "Styling" tab (material.angular.dev) lists the same names without the `--mat-` prefix (it is client-rendered; read the SCSS instead).

## System tokens Material 22.2 reads (`--mat-sys-*`)

Colours: `primary`, `on-primary`, `primary-container`, `on-primary-container`, `inverse-primary`, `secondary`, `secondary-container`, `on-secondary-container`, `tertiary-container`, `error`, `on-error`, `on-error-container`, `background`, `on-background`, `surface`, `on-surface`, `surface-variant`, `on-surface-variant`, `surface-container-low`, `surface-container`, `surface-container-high`, `surface-container-highest`, `inverse-surface`, `inverse-on-surface`, `outline`, `outline-variant`, `neutral10`, `neutral-variant20`.
Typography (each with `-font`, `-size`, `-line-height`, `-weight`, `-tracking`, plus a shorthand without suffix for some): `body-large|medium|small`, `label-large|medium|small`, `title-large|medium|small`, `headline-small`.
Shape: `corner-none`, `corner-extra-small`, `corner-medium`, `corner-large`, `corner-extra-large`, `corner-full`.
State layers: `hover-state-layer-opacity`, `focus-state-layer-opacity`, `pressed-state-layer-opacity`.
Elevation: `level0` … `level4` (box-shadows).

## Current mapping in `apps/web/src/styles.css`

### System tokens (global `:root`)

| Token(s) | Value |
|---|---|
| `primary`, `secondary` | `var(--accent)` |
| `on-primary` | `var(--on-accent)` |
| `surface`, `surface-container-high` | `var(--bg)` |
| `surface-container`, `surface-container-highest`, `inverse-surface`, `primary-container`, `secondary-container` | `var(--surface)` |
| `on-surface`, `inverse-on-surface`, `on-primary-container`, `on-secondary-container` | `var(--text)` |
| `on-surface-variant`, `outline` | `var(--muted)` |
| `outline-variant` | `var(--border)` |
| `error` | `var(--danger)` |
| `tertiary-container` | `var(--highlight)` |
| `corner-extra-small` / `-medium` / `-large` / `-extra-large` | 6px / 8px / 12px / 12px |
| `hover-` / `focus-` / `pressed-state-layer-opacity` | 0.08 / 0.12 / 0.12 |
| `body-large|medium|small-*`, `label-large-*`, `title-small-*`, `headline-small-*` | `font: inherit` (the app font), sizes 15/15/13 px body, 13 px labels (500), 15 px title-small (600), 18 px headline-small (600), tracking `normal` |

### Component tokens (global `:root`)

| Component | Tokens set |
|---|---|
| Table | `--mat-table-background-color: var(--surface)`, header/row heights 40px, `row-item-outline-color: var(--border)`, header/row text `var(--text)`; `--mat-sort-arrow-color: var(--muted)` |
| Paginator | background transparent, text `var(--muted)`, enabled icon `var(--text)`, disabled icon `var(--border)` |
| Buttons | filled/outlined/text `container-height` 36px and `container-shape` 6px, horizontal padding 16/14/10px, `outlined-outline-color: var(--border)`, `outlined-label-text-color: var(--text)`, `text-label-text-color: var(--accent)`, `--mat-icon-button-icon-color: var(--muted)` |
| Button toggle | height 36px, shape 6px, divider `var(--border)`, text `var(--text)`, background `var(--bg)`, selected background `var(--accent)`, selected text `var(--on-accent)` |
| Tabs (`mat-tab-nav-bar`) | `container-height: 40px`, `label-text-weight: 500`, divider `var(--border)` 1px, active/active-hover/active-focus indicator `var(--accent)` 2px, active (+hover/focus) label `var(--text)`, inactive label `var(--muted)`, inactive hover/focus label `var(--text)`, active/inactive ripple `var(--text)`, pagination icon `var(--text)` |
| Slide toggle | unselected track/hover/focus/pressed track and unselected icon `var(--surface)`, disabled unselected track/icon `var(--surface)`, handle and track shape 9999px |
| Datepicker | in-range day `color-mix(in srgb, var(--accent) 16%, transparent)`, calendar container shape 12px, today outline `var(--muted)` |
| Dialog | container `var(--bg)`, shape 12px, subhead and supporting text `var(--text)` |
| Form field | `container-height: 40px`, `container-vertical-padding: 8px` (Material's density −4 values), outlined outline `var(--border)`, hover outline `var(--muted)`, label `var(--muted)` |
| Menu | container `var(--bg)`, shape 8px, item label `var(--text)`, item icon `var(--muted)` |
| Tooltip | supporting text size 0.875rem, line height 1.4 (colours via `inverse-surface`/`inverse-on-surface`) |

### Scoped overrides (classes in `styles.css`)

| Selector | Tokens | Used by |
|---|---|---|
| `.danger-button` | `--mat-button-text-label-text-color: var(--danger)`, `--mat-button-filled-container-color: var(--danger)`, `--mat-button-filled-label-text-color: var(--on-danger)`, `--mat-menu-item-label-text-color` / `--mat-menu-item-icon-color: var(--danger)` | Delete buttons, Block menu items |
| `.app-menu` | Tailwind `@apply border border-line` (the panel has no border token; the shadow barely shows on the dark page) | `mat-menu class="app-menu"` (the `class` input goes on the panel) |
| `.alert-chip`, `.alert-chip[data-level='warn'|'error']` | `--mat-chip-container-height`, `--mat-chip-elevated-container-color`, `--mat-chip-label-text-color`, `--mat-chip-outline-color` | History chips |
| `.farm-pill` | `--mat-chip-container-height` (22px), `--mat-chip-container-shape-radius`, `--mat-chip-elevated-container-color`, `--mat-chip-outline-color`, `--mat-chip-label-text-{color,size,line-height,weight,tracking}`, `--mat-chip-hover-state-layer-opacity: 0`; plain CSS on `.mdc-evolution-chip__action--primary` (padding, cursor) and `.mdc-evolution-chip__text-label` (`user-select`), which have no tokens | `FarmPill` (farm ids) |
| `.app-tooltip .mat-mdc-tooltip-surface` | Tailwind `@apply` (width, border, padding, `whitespace-pre-line`, shadow): the one place we style a Material internal class, because the tooltip panel has no tokens for these | `matTooltipClass="app-tooltip"` |
| `.mat-mdc-table .mat-mdc-header-cell, .mat-mdc-cell` | `@apply px-3 whitespace-nowrap` | every table |
| `tr.mat-mdc-row.history-detail-row`, `.detail-row` | `height: auto`; `[hidden]` → `display: none` | expandable rows |

Per-element one-offs use Tailwind arbitrary properties: `class="[--mat-icon-button-icon-size:20px] [--mat-icon-button-state-layer-size:32px]"` (filter clear button), `data-[enabled=false]:[--mat-table-row-item-label-text-color:var(--muted)]` (muted rule row).

## Adding tokens for a new component

1. Find its tokens (command above) and their fallbacks; most colours already follow the system mapping. Check it in both schemes before adding anything.
2. Add only what differs, in the global `:root` block with a comment saying what it is for, or in a class for a variant (`.danger-button` style).
3. Map to **our** variables (`var(--surface)`), never hex values, so dark mode follows.
4. Check contrast numerically for new text/background pairs (≥ 4.5:1 text, ≥ 3:1 UI parts and focus indicators) in both themes.
5. Run the "is every token real" check.

## Unlayered Material vs layered Tailwind

Tailwind v4 emits utilities inside `@layer utilities`; Material's component styles are unlayered, and unlayered rules beat layered ones regardless of specificity. Consequences:
- Where Material sets a property, a plain utility loses: use `!` (`size-5!`, `text-muted!`, `text-right!`) or, better, the component token.
- Never put `display`/layout utilities (`grid`, `flex`, `block`) on a Material host (`mat-dialog-content`, `mat-form-field`, `mat-chip-set`, `mat-row`): Material's `display` wins; wrap the content in a `<div>`.
- Utilities that Material doesn't set (margins on the host, widths like `w-72`) work without `!`.

## Density

There is no density setting here (no `mat.theme`). Compact sizes come from the height tokens: form fields 40px with 8px vertical padding (= Material density −4), buttons and toggles 36px (= button density −1), table rows 40px. Material warns that density below 0 reduces touch targets; buttons keep their 48px touch target (`--mat-button-*-touch-target-display` stays at its default `block`).

## Focus indicators

Material shows focus with a state layer (`--mat-sys-focus-state-layer-opacity`, 0.12 here). Its strong focus indicator is pure CSS in 22.2, no Sass needed: `.mat-focus-indicator::before` reads `--mat-focus-indicator-display` (default `none`), `-border-color`, `-border-width` (3px), `-border-style` and `-border-radius`. Setting `--mat-focus-indicator-display: block` and a border colour in `styles.css` turns it on for every Material control. Toggle buttons have `outline: none` and otherwise show focus only as the state layer, which is nearly invisible on the accent-filled selected toggle. Not enabled yet (an app-wide change that needs a browser check). Our own elements use Tailwind `focus-visible:` utilities; check Material controls' focus visibility in both themes when changing state-layer tokens.

## Pitfalls

- A token set on `:root` that a component reads with a *component-level* default (e.g. `--mat-table-background-color`) wins over the system fallback; to change one table, set the component token on that element, not the system token.
- `color` inputs (`color="primary"`, `color="warn"`) are M2 palette switches; with no theme they do nothing useful. Use tokens.
- The `prebuilt-themes/*.css` files are a full theme: never add one to `angular.json`.
- After a Material upgrade, rerun the token check: renamed tokens fail silently.
