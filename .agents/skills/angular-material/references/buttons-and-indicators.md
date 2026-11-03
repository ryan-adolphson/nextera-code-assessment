# Buttons, toggles, chips, badges, progress and icons (Material 22.2)

Verified against `material/types/{button,button-toggle,_button-toggle-chunk,chips,badge,_badge-chunk,progress-bar,_progress-spinner-chunk,icon,_icon-registry-chunk}.d.ts` and the compiled `fesm2022/*.mjs` templates.

## Buttons (`@angular/material/button`)

| Class (import) | Selector | Inputs |
|---|---|---|
| `MatButton` (also exported as `MatAnchor`) | `button[matButton]`, `a[matButton]` (+ legacy `mat-button`, `mat-raised-button`, `mat-flat-button`, `mat-stroked-button`) | `matButton` = appearance `'text' \| 'filled' \| 'elevated' \| 'outlined' \| 'tonal'` (empty = text, or `MAT_BUTTON_CONFIG.defaultAppearance`) |
| `MatIconButton` (`MatIconAnchor`) | `button[matIconButton]`, `a[matIconButton]` (+ legacy `mat-icon-button`) | – |
| `MatFabButton`, `MatMiniFabButton` (+ anchors) | `[matFab]` (`extended` input), `[matMiniFab]` | – |

Common inputs (`MatButtonBase`): `disabled`, `disabledInteractive`, `aria-disabled`, `disableRipple`, `tabIndex`, `color` (M2 palette; don't use), and the signal input `showProgress` (shows a projected `[progressIndicator]` element over the label). Export names: `matButton`, `matAnchor`. Global defaults: `MAT_BUTTON_CONFIG` (`{ disabledInteractive?, color?, defaultAppearance? }`).

Content projection: a `mat-icon` (or `[matButtonIcon]`) before the label is the leading icon; add `iconPositionEnd` to put it after.

**Repo conventions**

| Role | Markup |
|---|---|
| Primary (one per area) | `<button matButton="filled" type="submit">` |
| Secondary / Cancel / Retry | `<button matButton="outlined" type="button">` |
| Low-emphasis | `<button matButton type="button">` (text) |
| Icon-only | `<button matIconButton type="button" aria-label="Clear search"><mat-icon svgIcon="close" /></button>` |
| Destructive | add `class="danger-button"` (danger text; a filled one gets a solid `--danger` fill with `--on-danger` text) |
| Busy | `[disabled]="saving()"` and change the label ("Saving…") |

- Always set `type` (`submit` only for the form's main action).
- Navigation is `<a>` (with `routerLink`), actions are `<button>`. A disabled anchor gets `aria-disabled="true"` and `tabindex="-1"`.
- Icon-only buttons need `aria-label`; per-row buttons need the row in the name (`sr-only` text: "Delete rule: Gearbox temperature above 120 °C").
- `disabledInteractive`: keeps the button focusable with `aria-disabled="true"` so you can explain *why* it is disabled (e.g. with a tooltip); it no longer blocks clicks, so guard the handler. Not used in the repo yet.
- **Template refs resolve to the component**, not the element: `viewChild('next', { read: ElementRef })` then `.nativeElement.focus()` (see `alerting/delete-rule-dialog.ts`, which focuses after a state change with `afterNextRender(…, { injector })`).
- Smaller icon buttons inside a field: set tokens with Tailwind arbitrary properties on the button, e.g. `class="[--mat-icon-button-icon-size:20px] [--mat-icon-button-state-layer-size:32px]"` (turbine filter clear button).

Tokens (all exist in 22.2): `--mat-button-{filled,outlined,text,tonal,protected}-*` (container height/shape/colour, label text colour/font/size/weight/transform, horizontal padding, icon spacing/offset, state layer colour/opacities, touch target), `--mat-icon-button-*` (`icon-color`, `icon-size`, `state-layer-size`, `container-shape`, `touch-target-*`…), `--mat-fab-*`. The repo sets the 36px heights, 6px shapes, paddings, the outlined outline/label colours, the text label colour and `--mat-icon-button-icon-color` (theming-tokens.md).

## Button toggle (`@angular/material/button-toggle`)

| Class | Selector | Inputs / outputs |
|---|---|---|
| `MatButtonToggleGroup` | `mat-button-toggle-group` (export `matButtonToggleGroup`) | `value`, `multiple`, `name`, `vertical`, `disabled`, `disabledInteractive`, `appearance` (`'standard' \| 'legacy'`), `hideSingleSelectionIndicator`, `hideMultipleSelectionIndicator`; outputs `change` (`MatButtonToggleChange`: `source`, `value`), `valueChange`. It is a `ControlValueAccessor`. |
| `MatButtonToggle` | `mat-button-toggle` | `value`, `checked`, `disabled`, `disabledInteractive`, `aria-label`, `aria-labelledby`, `appearance`, `name`, `id`; output `change` |

ARIA (from the template): single-selection group = `role="radiogroup"`, each toggle's inner `<button>` is `role="radio"` with `aria-checked`; `multiple` group = `role="group"` with `aria-pressed` buttons. Name the group with `aria-labelledby` (Settings: `aria-labelledby="time-zone-heading"`) or `aria-label`.

Repo uses: turbine page range (6h/24h/48h/7d), farm History range (`farm-history-range-30d|90d|6m`), Settings time zone (`hideSingleSelectionIndicator`, `[value]="settings.mode()" (change)="choose($event.value)"`). Tokens: `--mat-button-toggle-*` (standard) and `--mat-button-toggle-legacy-*` (only for `appearance="legacy"`; don't use). The repo sets height 36px, shape 6px, divider, text, background, selected background (`--accent`) and selected text (`--on-accent`). Playwright: `getByRole('radio', { name: '48h' })`.

**Long labels can't wrap:** `.mat-button-toggle-group` is `inline-flex` + `white-space: nowrap` + `overflow: hidden`, and the label's line-height is `--mat-button-toggle-height`. Check phone width (320/360px) with the longest label, or use `vertical` (e.g. bound to a `BreakpointObserver` signal). Never truncate a label.

## Chips (`@angular/material/chips`)

| Container | Chip | Use |
|---|---|---|
| `mat-chip-set` (`role="presentation"` while it has chips, none when empty; `role` input overrides) | `mat-chip` / `mat-basic-chip` (`MatChip`, no role by default) | read-only labels (repo: triggered alert rules) |
| `mat-chip-listbox` (`role="listbox"`; `multiple`, `selectable`, `value`, `compareWith`, `required`; output `change`) | `mat-chip-option` (`selected`, `selectable`; `selectionChange`) | choosing chips (not used) |
| `mat-chip-grid` (`role="grid"`, a form-field control) + `input[matChipInputFor]` | `mat-chip-row` (`editable`; `edited`) | entering chips (not used) |

`MatChip` inputs: `value`, `removable`, `highlighted`, `disabled`, `disableRipple`, `role`, `aria-label`, `aria-description`; output `removed`. Parts: `[matChipAvatar]`, `[matChipTrailingIcon]`, `[matChipRemove]`, `[matChipEdit]`.

Repo pattern (`alerting/alert-chips.ts`, a local component so the History page can `@defer` it):

```html
<mat-chip-set role="list" aria-label="Triggered alerts" data-testid="reading-alert-chips">
  @for (alert of reading().alerts; track alert.id) {
    <mat-chip role="listitem" class="alert-chip" disableRipple data-testid="alert-chip"
              [attr.data-level]="alert.alertLevel">{{ describe(reading(), alert) }}</mat-chip>
  }
</mat-chip-set>
```

**A single read-only chip (`ui/farm-pill.ts`, `FarmPill`):** a bare `<mat-chip disableRipple>` without a `mat-chip-set`, for one id next to a name (`Prairie Ridge` + `FARM01`). A `MatChip` doesn't need the set; with no actions it has no role, no `tabindex` and no click handler, so screen readers read plain text and a click reaches the row around it. Its `.farm-pill` tokens are in `styles.css`. The chip's text is `user-select: none`, its padding is fixed at 12px and its presentational part has `cursor: auto`; none has a token, so `.farm-pill` overrides those internal classes (raise the specificity with `.mat-mdc-standard-chip.farm-pill`: component styles load after `styles.css`). Whitespace-only text between two elements is dropped by the compiler, so write `</a>&ngsp;<app-farm-pill />`, or text before it. Keep it outside the name's link. Cost: `@angular/material/chips` adds about 36 KB raw, 6 KB transfer, to the first route that uses it (a shared lazy chunk, also used by `AlertChips`).

Colours by level come from `.alert-chip[data-level=…]` rules in `styles.css` that set `--mat-chip-elevated-container-color`, `--mat-chip-label-text-color`, `--mat-chip-outline-color` and `--mat-chip-container-height`; the text names the level too ("Error: …"), so colour is never the only cue.

## Status pills and badges

- Status words are **our own pills**, not Material: `AlertLevelBadge` (`alerting/alert-level-badge.ts`: Info neutral `bg-surface` + accent dot, Warning `bg-warn text-on-warn`, Error `bg-danger text-on-danger`) and `StalenessBadge` (`fleet/staleness-badge.ts`). Contrast rules: `--caution`/`--warn` fail as text on white, so status text sits on a solid pill with the matching `--on-*` colour or next to a coloured dot.
- `matBadge` (`[matBadge]`; inputs `matBadge` content, `matBadgeDescription`, `matBadgePosition` `'above after' | 'above before' | 'below before' | 'below after' | 'before' | 'after' | 'above' | 'below'`, `matBadgeSize` `'small' | 'medium' | 'large'`, `matBadgeOverlap`, `matBadgeHidden`, `matBadgeDisabled`) renders an `aria-hidden` bubble and exposes `matBadgeDescription` only through `aria-describedby`. It warns when placed on an `aria-hidden` `mat-icon`. Not used here; a count that matters goes into the accessible name as `sr-only` text.

## Progress (`@angular/material/progress-bar`, `/progress-spinner`)

- `mat-progress-bar`: `mode` `'determinate' | 'indeterminate' | 'buffer' | 'query'`, `value`, `bufferValue`; output `animationEnd`. Tokens `--mat-progress-bar-*`.
- `mat-progress-spinner` / `mat-spinner`: `mode` `'determinate' | 'indeterminate'`, `value`, `diameter`, `strokeWidth`. Tokens `--mat-progress-spinner-*`.
- Give either an `aria-label` (they are `role="progressbar"`). Inside a button with `showProgress`, the indicator must not be focusable.
- Repo: loading is shown as text in a `role="status"` region (`report-status`, `farm-history-status`) and with `@defer` skeletons (`ChartSkeleton`, `MapPlaceholder`) that keep the layout; no Material progress components yet.

## Icons (`@angular/material/icon`)

`MatIcon` (`mat-icon`, export `matIcon`): inputs `svgIcon`, `fontIcon`, `fontSet`, `inline`, `color`. Host attributes: `data-mat-icon-type="svg|font"`, `data-mat-icon-name` (the `svgIcon` name), `data-mat-icon-namespace`. It sets `aria-hidden="true"` unless you give it another `aria-hidden` value.

`MatIconRegistry`: `addSvgIcon(name, url)`, `addSvgIconLiteral(name, safeHtml, options?)`, `addSvgIconInNamespace…`, `addSvgIconLiteralInNamespace…`, `registerFontClassAlias`, `setDefaultFontSetClass`.

Repo setup (`src/app/ui/icons.ts`): Material Symbols (outlined, weight 400) from `@material-symbols/svg-400`, imported as SVG markup strings (`angular.json` `loader: { ".svg": "text" }`, typed by `src/types/svg.d.ts`), listed in `ICONS` (`IconName` = its keys) and registered once by `provideIcons()` with `addSvgIconLiteral` + `DomSanitizer.bypassSecurityTrustHtml` (trusted build-time assets only). `provideIcons()` is in `appConfig` and in `openFleet`'s providers. To add an icon:

```ts
import download from '@material-symbols/svg-400/outlined/download.svg';
export const ICONS = { /* … */ download } as const satisfies Record<string, string>;
```

Rules:
- No icon font, no `addSvgIcon(url)` (no HTTP), no ligature text (`<mat-icon>close</mat-icon>` would put "close" in `textContent`).
- Size/colour: `mat-icon`'s own rules are unlayered, so use `!` utilities: `class="size-5! text-muted!"`, `[class]="ok ? 'text-ok!' : 'text-muted!'"`.
- Meaning: the icon is hidden from AT, so pair it with `sr-only` text (Commissioned column) or put the name on the enclosing button (`aria-label`).
- Specs assert `data-mat-icon-name`, never the SVG markup. Tokens: `--mat-icon-color`.

## Harnesses

`MatButtonHarness` (`click`, `getText`, `isDisabled`, `getAppearance`, `getVariant`, `getType`, `isShowingProgress`, `focus`/`blur`), `MatButtonToggleGroupHarness` (`getToggles`, `isDisabled`, `isVertical`, `getAppearance`), `MatButtonToggleHarness` (`check`, `uncheck`, `toggle`, `isChecked`, `getText`, `getAriaLabel`), `MatChipSetHarness` (`getChips`), `MatChipHarness` (`getText`, `isDisabled`, `remove`, `getRemoveButton`, `getAvatar`; its edit-button getter is spelled `geEditButton` in 22.2), `MatBadgeHarness`, `MatProgressBarHarness`/`MatProgressSpinnerHarness` (`getValue`, `getMode`), `MatIconHarness` (`getName`, `getType`, `getNamespace`, `isInline`).

## Pitfalls

- Legacy selectors (`mat-raised-button`, `mat-flat-button`, `mat-stroked-button`) still match `MatButton` in 22.2; don't use them.
- `.mdc-button:disabled` has `pointer-events: none`: a tooltip on a disabled button never shows. Put the tooltip on a wrapper or use `disabledInteractive`.
- Changing a button's colour with `text-*` utilities loses to Material's token-driven colour; set the token (`--mat-button-text-label-text-color`) on a class or with an arbitrary property.
- A `mat-button-toggle-group` with `[value]` and `(change)` is one-way state; don't also bind `[checked]` on the toggles.
- A `mat-chip-set` is `role="presentation"` and its chips have no role, so an `aria-label` on the set is not a usable name (a generic element can't be named). If list semantics matter, set `role="list"` on the set and `role="listitem"` on each chip (both are inputs), or put the chips in a labelled region. `alert-chips.ts` sets both roles.
