# Testing Material UI (Vitest + TestBed, zoneless)

Verified against `cdk/types/{testing,testing-testbed,_harness-environment-chunk}.d.ts`, `material/types/*-testing.d.ts` (+ `_*harness*-chunk.d.ts`), their `fesm2022` implementations, and this repo's specs (`fleet/testing.ts`, `alerting/*.spec.ts`, `reporting/reporting-page.spec.ts`, `settings/settings-page.spec.ts`, `unallocated/unallocated-pages.spec.ts`) and `e2e/tests/**`.

## Setup: `openFleet`

Page specs open the real routes with `openFleet(url, clock, farms?, beforeOpen?, role = 'admin', options?)` from `src/app/fleet/testing.ts`. Its providers matter for Material:
- `provideIcons()`: `mat-icon svgIcon` resolves (no HTTP).
- `{ provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } }` (`@angular/material/core`; `AnimationsConfig { animationsDisabled? }`): overlays open and close without animation timers.
- `{ provide: InteractivityChecker, useClass: LayoutlessInteractivityChecker }`: jsdom has no layout, so CDK would find nothing visible/tabbable and `autoFocus`/`cdkFocusInitial` would fall back to the container.
- `app.stable()` = `settle()` (`whenStable`, a task, `whenStable`) for `@defer` and overlay timing; `app.root()`, `app.text(el)`, `app.http` (`HttpTestingController`), `app.harness.fixture`.

A spec that doesn't use `openFleet` but opens dialogs or icons must add those providers itself.

## Harness environment

```ts
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
const loader = TestbedHarnessEnvironment.loader(app.harness.fixture);               // inside the fixture
const docLoader = TestbedHarnessEnvironment.documentRootLoader(app.harness.fixture); // whole document (overlays)
const pages = await loader.getHarness(MatPaginatorHarness.with({ selector: '[data-testid=turbines-paginator]' }));
```

- `HarnessLoader`: `getHarness`, `getHarnessOrNull`, `getHarnessAtIndex`, `getAllHarnesses`, `countHarnesses`, `hasHarness`, `getChildLoader(selector)`, `getAllChildLoaders`. `TestbedHarnessEnvironment.harnessForFixture(fixture, Harness)` for a component's own harness. Utilities `parallel(() => [...])`, `manualChangeDetection(fn)` (`@angular/cdk/testing`).
- `Harness.with({ selector, … })` filters (most harnesses also accept `label`, `text`, `ancestor`…). Select by `data-testid` when a page has several.
- **Use `documentRootLoader` for anything inside an overlay** (a dialog's fields, `MatDialogHarness`). Harnesses whose panel is an overlay (autocomplete options, tooltip text, datepicker calendar, paginator page-size select) find the panel themselves from a fixture loader, but the *trigger* must be in the loader's root: an autocomplete inside a dialog needs `documentRootLoader` (`unallocated-pages.spec.ts`).
- Every harness action waits for the app to be stable (`whenStable`) before and after.

## Harness reference (22.2.2 method names)

| Harness (import from `@angular/material/<x>/testing`) | Methods |
|---|---|
| `MatButtonHarness` | `click`, `getText`, `isDisabled`, `getAppearance`, `getVariant`, `getType`, `isShowingProgress`, `focus`, `blur`, `isFocused` |
| `MatButtonToggleGroupHarness` | `getToggles`, `isDisabled`, `isVertical`, `getAppearance` |
| `MatButtonToggleHarness` | `check`, `uncheck`, `toggle`, `isChecked`, `isDisabled`, `getText`, `getName`, `getAriaLabel`, `getAriaLabelledby`, `getAppearance`, `focus`, `blur` |
| `MatFormFieldHarness` (`form-field/testing`) | `getLabel`, `hasLabel`, `isLabelFloating`, `getAppearance`, `hasErrors`, `getTextErrors`, `getErrors`, `getTextHints`, `getPrefixText`, `getSuffixText`, `getControl`, `isDisabled`, `isControlTouched`, `isControlDirty`, `isControlValid`, `isControlPending` |
| `MatInputHarness` (`input/testing`) | `setValue`, `getValue`, `getName`, `getType`, `getPlaceholder`, `getId`, `isDisabled`, `isRequired`, `isReadonly`, `focus`, `blur`, `isFocused` |
| `MatNativeSelectHarness`, `MatNativeOptionHarness` (`input/testing`) | `selectOptions(filter)`, `getOptions`, `isMultiple`, `isRequired`, `isDisabled`, `getName`, `getId`; option `getText`, `getIndex`, `isSelected`, `isDisabled` |
| `MatAutocompleteHarness` | `enterText`, `clear`, `getValue`, `getOptions`, `getOptionGroups`, `selectOption(filter)`, `isOpen`, `isDisabled`, `focus`, `blur` |
| `MatOptionHarness`, `MatOptgroupHarness` (`core/testing`) | option `click`, `getText`, `isSelected`, `isActive`, `isDisabled`; group `getLabelText`, `getOptions`, `isDisabled` |
| `MatDateRangeInputHarness` (`datepicker/testing`) | `getStartInput`, `getEndInput`, `getValue`, `getLabel`, `getSeparator`, `isDisabled`, `isRequired`, `openCalendar`, `closeCalendar`, `isCalendarOpen`, `hasCalendar`, `getCalendar` |
| `MatStartDateHarness` / `MatEndDateHarness` / `MatDatepickerInputHarness` | `setValue`, `getValue`, `getMin`, `getMax` (ISO strings), `getPlaceholder`, `isDisabled`, `isRequired`, `focus`, `blur` (+ calendar methods on the single-date input) |
| `MatCalendarHarness`, `MatCalendarCellHarness` | `getCells`, `selectCell`, `next`, `previous`, `changeView`, `getCurrentView`, `getCurrentViewLabel`; cell `select`, `getText`, `getAriaLabel`, `isSelected`, `isDisabled`, `isToday`, `isRangeStart`, `isRangeEnd`, `isInRange` |
| `MatSlideToggleHarness` | `check`, `uncheck`, `toggle`, `isChecked`, `isDisabled`, `isRequired`, `isValid`, `getLabelText`, `getAriaLabel`, `getName`, `focus`, `blur` |
| `MatCheckboxHarness`, `MatRadioGroupHarness`/`MatRadioButtonHarness` | `check`/`uncheck`/`toggle`, `isChecked`, …; group `checkRadioButton`, `getCheckedValue`, `getRadioButtons` |
| `MatChipSetHarness`, `MatChipHarness` | `getChips`; chip `getText`, `isDisabled`, `remove`, `getRemoveButton`, `getAvatar` (edit button getter: `geEditButton`, sic) |
| `MatTableHarness`, `MatRowHarness`, `MatCellHarness` | `getRows`, `getHeaderRows`, `getFooterRows`, `getNoDataRow`, `getCellTextByIndex`, `getCellTextByColumnName`; row `getCells`; cell `getText`, `getColumnName` |
| `MatSortHarness`, `MatSortHeaderHarness` | `getSortHeaders`, `getActiveHeader`; header `click`, `getLabel`, `getSortDirection`, `isActive`, `isDisabled` |
| `MatPaginatorHarness` | `goToNextPage`, `goToPreviousPage`, `goToFirstPage`, `goToLastPage`, `isNextPageDisabled`, `isPreviousPageDisabled`, `setPageSize`, `getPageSize`, `getRangeLabel` |
| `MatDialogHarness` | `getTitleText`, `getContentText`, `getActionsText`, `getText`, `close`, `getId`, `getRole`, `getAriaLabel`, `getAriaLabelledby`, `getAriaDescribedby` |
| `MatTooltipHarness` | `show`, `hide`, `isOpen`, `isDisabled`, `getTooltipText` |
| `MatIconHarness` | `getName`, `getType`, `getNamespace`, `isInline` |
| `MatTabNavBarHarness`, `MatTabLinkHarness` (`tabs/testing`) | bar `getLinks({ label })`, `getActiveLink`, `clickLink({ label })`, `getPanel` (→ `MatTabNavPanelHarness.getTextContent`); link `getLabel`, `isActive`, `isDisabled`, `click`. Each tab route renders its own bar, so look the bar up again after a navigation (the old host is detached). Keys: `(await link.host()).sendKeys(TestKey.RIGHT_ARROW)` (dispatches `keyCode`); Space is `sendKeys(' ')` (`TestKey` has no SPACE). Opening a tab whose page starts a resource: DOM `click()` + `NavigationEnd`, not the harness (it waits for stability) |
| `MatMenuHarness`, `MatSnackBarHarness`, `MatTabGroupHarness`, `MatExpansionPanelHarness`, `MatProgressBarHarness`, `MatBadgeHarness` | see the other references (not used by specs here) |

`MatTestDialogOpener.withComponent(Component, config?)` (`dialog/testing`) opens a dialog component in isolation.

## Pitfalls already hit in this repo

0. **Don't `await app.stable()` (`whenStable`) between `expectOne` and `flush`.** A loading resource is a pending task, so stability waits for it. Use `TestBed.tick()` to render the in-flight state, then flush.

1. **Overlays are outside the fixture.** Dialogs, calendars, autocomplete panels and tooltips render in `.cdk-overlay-container`. Query `document.querySelector('.cdk-overlay-container [data-testid=…]')`, not `app.root()`; don't query `document` broadly (earlier tests' roots can still be attached). Helper pattern (`alert-rules-page.spec.ts`): `app.root().querySelector(sel) ?? document.querySelector('.cdk-overlay-container ' + sel)`.
2. **Esc needs `keyCode` 27.** The CDK (dialog, tooltip, overlays) checks `event.keyCode === ESCAPE`; jsdom leaves `keyCode` 0:
   ```ts
   const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
   Object.defineProperty(event, 'keyCode', { get: () => 27 });
   (document.activeElement ?? document.body).dispatchEvent(event);
   await settle();
   ```
3. **`afterClosed` arrives a task after `close()`.** Await `new Promise((r) => setTimeout(r))` then `whenStable()` before asserting what the page did with the result (notice, reload request).
4. **Pending resources block harnesses.** A loading `latestLoad`/`rxResource` is a `PendingTasks` entry, so `whenStable()` and every harness action hang until its request is flushed. Order: `TestBed.tick()` → `http.expectOne(…)` → `flush` → `await new Promise((r) => setTimeout(r))` or `whenStable()`. Where a harness action would itself trigger a load (date range on History/Weather history), drive the DOM instead: `rangeCalendar(field)` (`fleet/testing.ts`: `open()`, `pick(day)`, `previousMonth()`, `isOpen()`; `closed` arrives a task after the end pick) or set input values and dispatch `input`/`change`/`blur`.
5. **Native selects bound with `[formField]`** update on `input`: set `.value`, dispatch `input` **and** `change`.
6. **No layout:** `getBoundingClientRect` is zeros, nothing scrolls, sticky/visibility can't be asserted, `IntersectionObserver` is stubbed (`test-setup.ts`). Say in the report what needs a browser check (layout, overflow on phones, focus ring visibility, contrast).
7. **Tooltip text is empty while closed:** `await tip.show()` before `getTooltipText()`.
8. **Template refs on Material buttons** are components: in specs click the element (`querySelector('[data-testid=…]').click()`), assert focus with `document.activeElement` against the element.
9. **Assert ARIA, not classes:** `aria-checked` on toggles (`querySelector('button').getAttribute('aria-checked')`), `aria-sort` on `th`, `aria-invalid`/`aria-required` on inputs, `aria-expanded` on expand buttons, `data-mat-icon-name` on icons, `role="dialog"` + `aria-labelledby` on `mat-dialog-container`. Accessible names: exclude `aria-hidden` parts.
10. **Locale:** the native date adapter formats en-US in jsdom (`'1/2/2026'`); `getMax()` returns ISO (`'2026-01-02'`).
11. **`@defer` blocks** that wrap Material (chips) render via `openFleet`'s `preloadDeferredViews()`; with a pending resource use `renderDeferred(fixture)`.

## Playwright locators for Material controls (`e2e/`)

The built app exposes real ARIA, so use roles and names:

| Control | Locator |
|---|---|
| `matButton` / `matIconButton` | `getByRole('button', { name: 'Add rule' })`, icon-only by its `aria-label` |
| Dialog | `getByRole('dialog', { name: 'Add alert rule' })` (named by `mat-dialog-title`) |
| Slide toggle | `getByRole('switch', { name: 'Enabled' })` |
| Button toggle (single) | `getByRole('radio', { name: '48h' })` |
| Outline field input / native select | `getByLabel('Threshold')`, `getByRole('combobox', { name: 'Metric' })` + `selectOption()` |
| Autocomplete | `getByRole('combobox', { name: 'Farm or turbine' })`, then `getByRole('listbox')` → `getByRole('group', { name: 'Farms' }).getByRole('option')` |
| Date range | `getByRole('button', { name: 'Open calendar' })`, then `getByRole('dialog').getByRole('button', { name: 'January 2, 2026' })` (disabled days are disabled buttons) |
| Paginator | `getByRole('button', { name: 'Next page' })` / `'Previous page'`; range label text "1 – 25 of 100" |
| Table | `getByRole('row')`, `getByRole('columnheader')`; sort headers carry `aria-sort` |

Prefer these and `data-testid` over `mat-*`/`cdk-*` class selectors. `textContent` runs `<li>` items together, so text regexes shouldn't rely on `\b`.
