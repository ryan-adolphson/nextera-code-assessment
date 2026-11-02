# Angular CDK 22.2

Verified against `cdk/types/{a11y,_a11y-module-chunk,_focus-monitor-chunk,overlay,_overlay-module-chunk,layout,clipboard,drag-drop,scrolling,text-field,platform,_platform-chunk,portal,accordion}.d.ts` and `cdk/fesm2022/*.mjs`. Import paths are the entry points (`@angular/cdk/a11y`, `/overlay`, `/layout`, …); `@angular/cdk` itself only exports `VERSION`.

Use the CDK when Material has no component for the job but the behaviour is a solved problem (focus, live announcements, positioning, breakpoints). Don't hand-roll these.

## Accessibility (`@angular/cdk/a11y`)

### Focus trap

- `cdkTrapFocus` directive (`[cdkTrapFocus]`, export `cdkTrapFocus`): `cdkTrapFocus` (enabled, boolean), `cdkTrapFocusAutoCapture` (focus the first element on init and restore focus on destroy).
- `FocusTrapFactory.create(element, deferCaptureElements?)` → `FocusTrap` (`focusInitialElement()`, `focusFirstTabbableElement()`, `focusLastTabbableElement()`, the `…WhenReady()` async variants, `destroy()`). `ConfigurableFocusTrapFactory` adds an inert strategy.
- `cdkFocusInitial` is a **plain attribute**, not a directive (no import): the trap focuses the first element carrying it. MatDialog uses the same trap, which is why `<button … mat-dialog-close cdkFocusInitial>Cancel</button>` works in the delete dialogs. If the element isn't focusable, the CDK warns "Element matching '[cdkFocusInitial]' is not focusable."
- Dialogs already trap focus; use `cdkTrapFocus` only for a custom modal surface (there is none in the app today).

### Focus origin

- `FocusMonitor`: `monitor(element | ElementRef, checkChildren?)` → `Observable<FocusOrigin>` (`'touch' | 'mouse' | 'keyboard' | 'program' | null`), `stopMonitoring(element)`, `focusVia(element, origin, options?)`. Always `stopMonitoring` in `DestroyRef.onDestroy`.
- Directives `[cdkMonitorElementFocus]` / `[cdkMonitorSubtreeFocus]` (output `cdkFocusChange`) add `cdk-focused` and `cdk-<origin>-focused` classes. Prefer Tailwind `focus-visible:` for styling; use the monitor only for logic.
- `InputModalityDetector`: `mostRecentModality`, `modalityDetected`, `modalityChanged` (`'keyboard' | 'mouse' | 'touch' | null`).

### Live announcements

- `LiveAnnouncer.announce(message, politeness?, duration?)` → `Promise<void>` (`AriaLivePoliteness` = `'off' | 'polite' | 'assertive'`), `clear()`. It writes into a shared visually hidden live element (`LIVE_ANNOUNCER_ELEMENT_TOKEN`, defaults via `LIVE_ANNOUNCER_DEFAULT_OPTIONS`).
- `[cdkAriaLive]` directive (`cdkAriaLive` politeness, `cdkAriaLiveDuration`) announces an element's text whenever it changes.
- Repo rule: a visible outcome goes into an always-rendered `role="status"` (or a `role="alert"`) element in the page (overlays.md); `LiveAnnouncer` is for outcomes with no visible text (none yet). In jsdom the announcer's element is in `document.body`, so assert visible text, not the announcer.

### Interactivity checks

`InteractivityChecker`: `isDisabled`, `isVisible`, `isTabbable`, `isFocusable(element, config?)`. jsdom has no layout, so `isVisible` is always false and nothing would be tabbable: `openFleet` (`fleet/testing.ts`) provides

```ts
@Injectable()
class LayoutlessInteractivityChecker extends InteractivityChecker {
  override isVisible(): boolean { return true; }
}
// providers: { provide: InteractivityChecker, useClass: LayoutlessInteractivityChecker }
```

so MatDialog's `autoFocus` and `cdkFocusInitial` work in specs. Any new spec setup that opens dialogs without `openFleet` needs the same provider.

### Descriptions, ids, key managers

- `AriaDescriber.describe(host, message, role?)` / `removeDescription(…)`: what `matTooltip`, `matBadge` and `mat-sort-header` use to add `aria-describedby` to a shared hidden message container. Use it for a description that isn't on screen; for visible hint text, point `aria-describedby` at it directly.
- `_IdGenerator` is private API (leading underscore): don't use it; use a stable id from data (`'history-detail-' + turbineId`).
- `addAriaReferencedId(el, attr, id)` / `removeAriaReferencedId` / `getAriaReferenceIds`: manage space-separated `aria-describedby`/`aria-labelledby` lists safely.
- Key managers for custom composite widgets: `ListKeyManager`, `FocusKeyManager` (roving focus; items implement `FocusableOption`), `ActiveDescendantKeyManager` (`aria-activedescendant`; items implement `Highlightable`), `TreeKeyManager`. Before building a composite widget, check Angular Aria (`angular-developer` skill, `angular-aria.md`) and Material first.
- Visually hidden: the CDK's `.cdk-visually-hidden` class (in `@angular/cdk/a11y-prebuilt.css`, not loaded here). Use Tailwind `sr-only`.

## Overlay (`@angular/cdk/overlay`)

All Material popups build on it. Stable factory functions (22.2): `createOverlayRef(injector, config?)`, `createFlexibleConnectedPositionStrategy(injector, origin)`, `createGlobalPositionStrategy(injector)`, `createRepositionScrollStrategy(injector, config?)`, `createBlockScrollStrategy(injector)`, `createCloseScrollStrategy(…)`, `createNoopScrollStrategy()`. The `Overlay` service still works ("primarily for authors of re-usable components").

`OverlayConfig`: `positionStrategy`, `scrollStrategy`, `panelClass`, `hasBackdrop`, `backdropClass`, `width`/`height`/`min*`/`max*`, `direction`, `disposeOnNavigation` (`boolean | 'url-change' | 'pop-state'`), `usePopover` (render as a native popover instead of inside `.cdk-overlay-container`), `disableAnimations`, `eventPredicate`. `OverlayRef`: `attach(portal)`, `detach()`, `dispose()`, `backdropClick()`, `keydownEvents()`, `outsidePointerEvents()`, `updatePosition()`, `updateSize()`.

Template form: `<button cdkOverlayOrigin #origin="cdkOverlayOrigin">` + `<ng-template cdkConnectedOverlay [cdkConnectedOverlayOrigin]="origin" [cdkConnectedOverlayOpen]="open()" (overlayOutsideClick)="close()" (detach)="close()">`. Preset positions: `STANDARD_DROPDOWN_BELOW_POSITIONS`, `STANDARD_DROPDOWN_ADJACENT_POSITIONS`.

`@angular/cdk/overlay-prebuilt.css` must be in `angular.json` styles (it is). Leaflet's panes use high z-indexes; overlays go into the container at the end of `<body>`, so they stack above the map.

## Portal (`@angular/cdk/portal`)

`ComponentPortal`, `TemplatePortal`, `DomPortal`, `[cdkPortalOutlet]`, and the `ComponentType<T>` type (used by `unallocated/unallocated-actions.ts` to accept any dialog component). For dynamic components in a template, prefer Angular's `NgComponentOutlet` or `ViewContainerRef.createComponent`.

## Layout (`@angular/cdk/layout`)

`BreakpointObserver.observe(query | query[])` → `Observable<BreakpointState>` (`matches`, `breakpoints` map), `isMatched(query)`; `Breakpoints` presets (`XSmall`…`XLarge`, `Handset`, `Tablet`, `Web`, `*Portrait`, `*Landscape`); `MediaMatcher.matchMedia(query)`. Use Tailwind breakpoints for styling; for logic pass the Tailwind query (`'(min-width: 48rem)'` = `md`) and `toSignal(...)`.

## Clipboard (`@angular/cdk/clipboard`)

`Clipboard.copy(text): boolean`, `beginCopy(text): PendingCopy` (`copy(attempts?)`, `destroy()`); directive `[cdkCopyToClipboard]="text"` (`cdkCopyToClipboardAttempts`, output `cdkCopyToClipboardCopied: boolean`). Announce the result ("Copied") in a status region.

## Drag and drop (`@angular/cdk/drag-drop`)

`cdkDropList` (`cdkDropListData`, `cdkDropListOrientation`, `cdkDropListConnectedTo`, `cdkDropListDisabled`, `cdkDropListSortingDisabled`, `cdkDropListLockAxis`, `cdkDropListEnterPredicate`, `cdkDropListSortPredicate`, `cdkDropListAutoScrollDisabled`; output `cdkDropListDropped`), `cdkDrag` (`cdkDragData`, `cdkDragLockAxis`, `cdkDragBoundary`, `cdkDragStartDelay`, `cdkDragDisabled`, `cdkDragPreviewClass`; outputs `cdkDragStarted`, `cdkDragEnded`, `cdkDragMoved`…), `cdkDragHandle`, `*cdkDragPlaceholder`, `*cdkDragPreview`; helpers `moveItemInArray(array, from, to)`, `transferArrayItem(...)`, `copyArrayItem(...)`. Drag-and-drop has no keyboard path: always offer buttons ("Move up/down") as well. Not used here.

## Scrolling (`@angular/cdk/scrolling`)

`<cdk-virtual-scroll-viewport itemSize="40" class="h-96">` + `*cdkVirtualFor="let r of rows(); trackBy: trackById"` (`cdkVirtualForTemplateCacheSize`), `minBufferPx`/`maxBufferPx`, `appendOnly`, output `scrolledIndexChange`; `CdkScrollable` (`cdk-scrollable`), `ScrollDispatcher`, `ViewportRuler`. Virtual scrolling doesn't combine with `mat-table` + `mat-paginator`; our tables page client-side instead (tables.md). Consider it only for a long non-table list. jsdom has no layout, so a virtual viewport renders few or no items in specs.

## Text field (`@angular/cdk/text-field`)

`textarea[cdkTextareaAutosize]` (`cdkAutosizeMinRows`, `cdkAutosizeMaxRows`, `cdkTextareaAutosize` enabled), `[cdkAutofill]` (output on autofill), `AutofillMonitor`. Needs `@angular/cdk/text-field-prebuilt.css` for autofill detection (not loaded; add it to `angular.json` styles if you use `cdkAutofill`).

## Platform (`@angular/cdk/platform`)

`Platform`: `isBrowser`, `BLINK`, `WEBKIT`, `FIREFOX`, `SAFARI`, `IOS`, `ANDROID`, `EDGE`, `TRIDENT`; helpers `getSupportedInputTypes()`, `normalizePassiveListenerOptions`, `supportsScrollBehavior`. Prefer feature detection; the app is browser-only (no SSR).

## Bidi, keycodes, coercion, collections

`Directionality` (`@angular/cdk/bidi`), keycode constants (`ESCAPE` = 27 … in `@angular/cdk/keycodes`; the CDK compares `event.keyCode`, which matters for jsdom: testing.md), `coerceBooleanProperty`/`coerceNumberProperty` (`@angular/cdk/coercion`; for signal inputs use `booleanAttribute`/`numberAttribute` transforms from `@angular/core` instead), `SelectionModel` (`@angular/cdk/collections`; we keep selections as `Set` signals).

## Testing harness infrastructure (`@angular/cdk/testing`, `/testing/testbed`)

`TestbedHarnessEnvironment.loader(fixture)`, `.documentRootLoader(fixture)`, `.harnessForFixture(fixture, Harness)`; `HarnessLoader.getHarness`, `getHarnessOrNull`, `getHarnessAtIndex`, `getAllHarnesses`, `countHarnesses`, `hasHarness`, `getChildLoader(selector)`, `getAllChildLoaders`; `parallel(() => [...])`, `manualChangeDetection(fn)`. Details and pitfalls in testing.md.
