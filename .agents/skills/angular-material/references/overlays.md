# Overlays: dialog, tooltip, menu, snack-bar, CDK overlay (Material 22.2)

Verified against `material/types/{dialog,_dialog-chunk,tooltip,menu,snack-bar,dialog-testing,tooltip-testing}.d.ts`, `cdk/types/{dialog,overlay,_overlay-module-chunk}.d.ts`, `material/fesm2022/{_tooltip-chunk,select}.mjs`, `cdk/fesm2022/dialog.mjs` and the 22.2.x docs sources.

All overlays render in `.cdk-overlay-container` (a child of `<body>`), outside the component tree. `@angular/cdk/overlay-prebuilt.css` is in `angular.json` `styles`; without it overlays have no positioning. The CDK can also render an overlay as a native `popover` (`OverlayConfig.usePopover`, `OVERLAY_DEFAULT_CONFIG`); in 22.2.2 only `mat-select` uses it by default (`'inline'`), so dialogs, tooltips, menus and the autocomplete/datepicker panels still use the container.

## MatDialog (`@angular/material/dialog`)

### Opening

```ts
const DIALOG_CONFIG: MatDialogConfig = {
  width: '32rem',
  maxWidth: 'calc(100vw - 2rem)',
  autoFocus: 'first-tabbable',
  ariaModal: true,
};
private readonly dialog = inject(MatDialog);
private readonly viewContainerRef = inject(ViewContainerRef);

this.dialog
  .open<RuleEditorDialog, RuleEditorData, RuleEditorResult>(RuleEditorDialog, {
    ...DIALOG_CONFIG,
    viewContainerRef: this.viewContainerRef, // the dialog's injector = the page's (page-provided stores)
    data: { rule },
  })
  .afterClosed()
  .subscribe((result) => { if (!result) return; this.notice.set(`Rule ${result.action}: …`); this.reload(); });
```

`MatDialog`: `open(componentOrTemplate, config?)` → `MatDialogRef<T, R>`, `closeAll()`, `getDialogById(id)`, `openDialogs`, `afterOpened` (Subject), `afterAllClosed`. Defaults for every dialog: `MAT_DIALOG_DEFAULT_OPTIONS`.

`MatDialogConfig<D>` fields (22.2): `viewContainerRef`, `injector`, `id`, `role` (`'dialog' | 'alertdialog'`), `panelClass`, `hasBackdrop`, `backdropClass`, `disableClose`, `closePredicate`, `width`, `height`, `minWidth`, `minHeight`, `maxWidth`, `maxHeight`, `position` (`{ top?, bottom?, left?, right? }`), `data`, `direction`, `ariaDescribedBy`, `ariaLabelledBy`, `ariaLabel`, `ariaModal`, `autoFocus` (`'dialog' | 'first-tabbable' | 'first-heading'` or a CSS selector; the docs table says `first-header`, the type says `first-heading`), `restoreFocus` (`boolean | string | HTMLElement`), `delayFocusTrap`, `scrollStrategy`, `closeOnNavigation` (`boolean | 'url-change' | 'pop-state'`), `enterAnimationDuration`, `exitAnimationDuration`, `bindings` (`Binding[]` for the component: `inputBinding`/`outputBinding`).

`ariaModal` is off by default in Material (it already hides the rest of the page from AT with `aria-hidden`); the repo sets it to `true` on purpose.

### Inside the dialog component

```ts
private readonly ref = inject<MatDialogRef<RuleEditorDialog, RuleEditorResult>>(MatDialogRef);
protected readonly editing = inject<RuleEditorData>(MAT_DIALOG_DATA).rule;
```

`MatDialogRef<T, R>`: `close(result?)`, `afterOpened()`, `afterClosed(): Observable<R | undefined>`, `beforeClosed()`, `backdropClick()`, `keydownEvents()`, `updatePosition()`, `updateSize()`, `addPanelClass()`/`removePanelClass()`, `getState()`, `componentInstance`, `disableClose`, `id`.

Directives (import each one used):

| Directive | Selector | Notes |
|---|---|---|
| `MatDialogTitle` | `[mat-dialog-title]`, `[matDialogTitle]` | its id becomes the container's `aria-labelledby` automatically; use an `h2` |
| `MatDialogContent` | `mat-dialog-content`, `[mat-dialog-content]`, `[matDialogContent]` | scrollable (`CdkScrollable` host directive) |
| `MatDialogActions` | `mat-dialog-actions`, … | `align`: `'start' \| 'center' \| 'end'` (repo: `end`) |
| `MatDialogClose` | `[mat-dialog-close]`, `[matDialogClose]` | `mat-dialog-close="result"`; sets `type="button"` unless given |

Repo shape (`alerting/rule-editor-dialog.html`):

```html
<h2 mat-dialog-title>{{ editing ? 'Edit alert rule' : 'Add alert rule' }}</h2>
<form [formRoot]="ruleForm">
  <mat-dialog-content>
    <!-- the grid is a div inside mat-dialog-content: Material's unlayered display:block wins over `grid` -->
    <div class="grid grid-cols-1 items-start gap-4 sm:grid-cols-2" data-testid="rule-fields">…</div>
  </mat-dialog-content>
  <mat-dialog-actions align="end">
    <button matButton="outlined" type="button" mat-dialog-close>Cancel</button>
    <button matButton="filled" type="submit" data-testid="rule-save" [disabled]="saving()">…</button>
  </mat-dialog-actions>
</form>
```

Repo rules:
- The dialog does its own write (POST/PATCH/DELETE) and closes with a result **only on success**; failures show inside it in a `role="alert"` paragraph. A 404 means "already gone elsewhere" (treat as done), a 409 gets a specific message and reloads the store behind the dialog.
- The host gets a `data-testid` (`host: { 'data-testid': 'rule-dialog' }`).
- Destructive confirmations focus Cancel first: `cdkFocusInitial` on the Cancel button (`DeleteRuleDialog`, `UnallocatedConfirmDialog`).
- When the dialog's content changes so the focused button disappears, move focus explicitly: `viewChild('next', { read: ElementRef })` + `afterNextRender(() => next()?.nativeElement.focus(), { injector })`.
- Generic helper: `unallocated/unallocated-actions.ts` opens any dialog component (`ComponentType<C>` from `@angular/cdk/portal`) with the shared config.

Accessibility you get: `role="dialog"` (or `alertdialog`), `aria-labelledby` = the title, `aria-modal` (set by us), focus trap, initial focus (`autoFocus` / `cdkFocusInitial`), Esc closes (unless `disableClose`), focus returns to the opener on close. If the opener is gone (e.g. a menu item), restore focus yourself in `afterClosed`.

Tokens: `--mat-dialog-container-color`, `-container-shape`, `-container-elevation-shadow`, `-container-max-width`, `-container-small-max-width`, `-container-min-width`, `-subhead-color/-font/-size/-weight/-line-height/-tracking`, `-supporting-text-*`, `-content-padding`, `-with-actions-content-padding`, `-headline-padding`, `-actions-padding`, `-actions-alignment`, `-transition-duration`. The repo sets container colour, 12px shape, subhead and supporting text colours; the title size comes from `--mat-sys-headline-small-*`.

## Tooltip (`@angular/material/tooltip`)

`MatTooltip` (`[matTooltip]`, export `matTooltip`): inputs `matTooltip` (message, a string), `matTooltipPosition` (`'left' | 'right' | 'above' | 'below' | 'before' | 'after'`), `matTooltipPositionAtOrigin`, `matTooltipDisabled`, `matTooltipShowDelay`, `matTooltipHideDelay`, `matTooltipTouchGestures` (`'auto' | 'on' | 'off'`), `matTooltipClass`. Methods `show(delay?)`, `hide(delay?)`, `toggle()`. Defaults (`MAT_TOOLTIP_DEFAULT_OPTIONS`): `showDelay` 0, `hideDelay` 0, `touchendHideDelay` 1500, plus optional `position`, `positionAtOrigin`, `touchGestures`, `touchLongPressShowDelay`, `disableTooltipInteractivity`, `tooltipClass`, `detectHoverCapability`.

Accessibility: Material adds an `aria-describedby` pointing at a hidden copy of the message (via `AriaDescriber`), so the trigger must be focusable and have its own name. Esc hides it; the pointer can move onto the tooltip.

Repo pattern (`alerting/alerts-cell.ts`):

```html
<button type="button" #tip="matTooltip" matTooltipClass="app-tooltip" matTooltipPosition="above"
        [matTooltip]="lines()" (click)="tip.show()" data-testid="alerts-cell-trigger">
  <app-alert-level-badge … />
</button>
```

- A real `<button type="button">` around the visible content (focusable, named by its content); `(click)="tip.show()"` so a tap opens it too.
- `matTooltipClass="app-tooltip"` (`styles.css`): left-aligned, max `min(20rem, 100vw - 16px)`, `whitespace-pre-line` so each `\n` in the message is a line, border, padding, shadow.
- Tokens: `--mat-tooltip-container-color`, `-container-shape`, `-supporting-text-color/-font/-size/-weight/-line-height/-tracking`. The repo sets size and line height; colours come from `--mat-sys-inverse-surface`/`--mat-sys-inverse-on-surface`, mapped to `--surface`/`--text`.
- Never put information only in a tooltip that a keyboard or touch user can't reach. Tooltips don't show on disabled buttons (`pointer-events: none`).

## Menu (`@angular/material/menu`, not used yet)

`mat-menu` (export `matMenu`; inputs `xPosition` `'before' | 'after'`, `yPosition` `'above' | 'below'`, `overlapTrigger`, `hasBackdrop`, `class`, `backdropClass`, `aria-label`/`-labelledby`/`-describedby`; outputs `closed`), `[mat-menu-item]` (`role` `'menuitem' | 'menuitemradio' | 'menuitemcheckbox'`, `disabled`, `disabledInteractive`; a leading `mat-icon`/`[matMenuItemIcon]`), trigger `[matMenuTriggerFor]` (`matMenuTriggerData`, `matMenuTriggerRestoreFocus`; outputs `menuOpened`, `menuClosed`), lazy content `ng-template[matMenuContent]`, and `[matContextMenuTriggerFor]` for right-click menus. Keyboard: arrows, Home/End, typeahead, Esc. Use a menu for a list of **actions**; for choosing a value use a native select or a button-toggle group. Tokens `--mat-menu-*`. Harnesses `MatMenuHarness`, `MatMenuItemHarness`, `MatContextMenuHarness`.

## Snack-bar (`@angular/material/snack-bar`): deliberately not used

API for reference: `MatSnackBar.open(message, action?, config?)`, `openFromComponent`, `openFromTemplate`; `MatSnackBarConfig`: `duration`, `politeness` (default polite), `announcementMessage`, `horizontalPosition` (`'start' | 'center' | 'end' | 'left' | 'right'`), `verticalPosition` (`'top' | 'bottom'`), `panelClass`, `data`, `viewContainerRef`, `direction`; parts `[matSnackBarLabel]`, `[matSnackBarActions]`, `[matSnackBarAction]`.

Why the repo uses in-page notices instead: a snack-bar never receives focus and disappears on a timer, so its action is hard to reach for keyboard and screen-reader users (the docs themselves say to provide another way to perform it and avoid `duration` with an action). Our pattern keeps the message next to the thing that changed and is trivially testable:

```html
<!-- the status region is always in the DOM (min-h-5 reserves its line); only its text changes -->
<p class="mt-4 min-h-5 text-sm text-muted" role="status" data-testid="rules-notice">{{ notice() }}</p>
<!-- role=alert is announced when inserted -->
@if (toggleError(); as message) { <p role="alert" data-testid="rules-toggle-error">{{ message }}</p> }
```

Keep a `role="status"` region rendered and change its text: a polite live region that is inserted together with its text is often not announced. `role="alert"` (assertive) may be inserted with its text.

For a message with no visible home, use `LiveAnnouncer.announce()` (cdk.md).

## CDK overlay for custom popups (rarely needed)

Prefer a Material component. If you must build one, 22.2 has injector-based factory functions (stable, exported from `@angular/cdk/overlay`): `createOverlayRef(injector, config?)`, `createFlexibleConnectedPositionStrategy(injector, origin)`, `createGlobalPositionStrategy(injector)`, `createRepositionScrollStrategy(injector, config?)`, `createBlockScrollStrategy(injector)`, `createCloseScrollStrategy`, `createNoopScrollStrategy`; or the template directives `cdkOverlayOrigin` + `cdkConnectedOverlay` (`cdkConnectedOverlayOrigin`, `…Open`, `…Positions`, `…HasBackdrop`, `…UsePopover`, `…MatchWidth`, `…DisposeOnNavigation`; outputs `backdropClick`, `attach`, `detach`, `overlayKeydown`, `overlayOutsideClick`). The `Overlay` service still exists (meant for component authors). Positions presets: `STANDARD_DROPDOWN_BELOW_POSITIONS`, `STANDARD_DROPDOWN_ADJACENT_POSITIONS`. Details in cdk.md.

## Testing overlays (details in testing.md)

- Query **`.cdk-overlay-container`**, not the fixture root: `document.querySelector('.cdk-overlay-container [data-testid=rule-dialog]')`. Earlier tests' roots may still be in the document, so don't query `document` broadly.
- Harnesses for things **inside** a dialog need `TestbedHarnessEnvironment.documentRootLoader(fixture)`; `MatDialogHarness` (`getTitleText`, `getContentText`, `getActionsText`, `close`, `getRole`, `getAriaLabelledby`) is found from the document root too.
- `afterClosed` emits a task after `close()`: `await new Promise((r) => setTimeout(r)); await fixture.whenStable();`.
- Esc: dispatch a `keydown` whose `keyCode` is 27 (`Object.defineProperty(event, 'keyCode', { get: () => 27 })`): the CDK checks `event.keyCode === ESCAPE`, and jsdom leaves it 0.
- `openFleet` provides `MATERIAL_ANIMATIONS` `{ animationsDisabled: true }` and a `LayoutlessInteractivityChecker`, so initial focus and the focus trap work without layout.
- Tooltips: `MatTooltipHarness.show()` before `getTooltipText()` (it returns `''` while closed).
