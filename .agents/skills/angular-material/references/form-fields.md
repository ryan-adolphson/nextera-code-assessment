# Form fields and form controls (Material 22.2)

Verified against `material/types/{form-field,_form-field-chunk,input,autocomplete,datepicker,slide-toggle,checkbox,radio,core,_error-options-chunk,_form-field-control-chunk}.d.ts`, `material/fesm2022/{input,_form-field-chunk,_error-options-chunk}.mjs` and `forms/types/{signals,_structure-chunk}.d.ts`.

## `mat-form-field` (`@angular/material/form-field`)

Imports: `MatFormField`, `MatLabel`, `MatError`, `MatHint`, `MatPrefix`, `MatSuffix` (also re-exported from `@angular/material/input`).

| Input | Values | Repo use |
|---|---|---|
| `appearance` | `'fill' \| 'outline'` (`MatFormFieldAppearance`) | always `outline` |
| `floatLabel` | `'always' \| 'auto'` (`FloatLabelType`) | `always` on filters, so placeholders show |
| `subscriptSizing` | `'fixed' \| 'dynamic'` (`SubscriptSizing`) | always `dynamic` (no reserved error line; the field grows only when an error shows) |
| `hideRequiredMarker` | boolean | default (the marker is `aria-hidden`) |
| `hintLabel` | string | – |
| `color` | M2-only palette name | don't use (no theme) |

Projected content and their selectors:
- `<mat-label>`: rendered as a native `<label for="<control id>">` (the floating label). That is the control's accessible name; don't add `aria-label` as well.
- `[matPrefix]`/`[matIconPrefix]`, `[matTextPrefix]`, `[matSuffix]`/`[matIconSuffix]`, `[matTextSuffix]`: icon slots vs text slots. Units are `<span matTextSuffix>`; a clear button is `<button matIconButton matSuffix>`.
- `<mat-hint>` (`align: 'start' | 'end'`), `<mat-error>` / `[matError]`: their ids are added to the control's `aria-describedby`. The subscript wrapper is `aria-live="polite" aria-atomic="true"`, so a new error is announced.
- Defaults for every field: `MAT_FORM_FIELD_DEFAULT_OPTIONS` (`MatFormFieldDefaultOptions`: `appearance`, `hideRequiredMarker`, `floatLabel`, `subscriptSizing`, `color`). The repo sets the attributes per field instead.

A field needs exactly one `MatFormFieldControl` inside ("mat-form-field must contain a MatFormFieldControl"): `matInput`/`matNativeControl`, `mat-date-range-input`, `mat-chip-grid`, `mat-select` (not used). `mat-slide-toggle`, `mat-checkbox` and `mat-radio-group` are **not** form-field controls: put them outside.

Repo example (rule editor, `alerting/rule-editor-dialog.html`):

```html
<mat-form-field appearance="outline" subscriptSizing="dynamic">
  <mat-label>Threshold</mat-label>
  <input matInput type="number" step="any" inputmode="decimal" data-testid="rule-value"
         aria-describedby="rule-value-unit" [formField]="ruleForm.threshold" />
  <span matTextSuffix class="pl-1 text-muted" id="rule-value-unit">{{ unit() }}</span>
  <mat-error data-testid="rule-value-error">{{ valueError() }}</mat-error>
</mat-form-field>
```

The suffix is also referenced from `aria-describedby` (the docs warn that screen readers may skip static prefix/suffix text); Material merges our ids with its hint/error ids (`userAriaDescribedBy`).

## `matInput` and native selects (`@angular/material/input`)

`MatInput` selector: `input[matInput], textarea[matInput], select[matNativeControl], input[matNativeControl], textarea[matNativeControl]` (export `matInput`). So **`MatInput` is the import for `<select matNativeControl>` too**; there is no separate native-select directive.

Inputs: `disabled`, `id`, `placeholder`, `name`, `required`, `type`, `errorStateMatcher`, `aria-describedby` (→ `userAriaDescribedBy`), `value`, `readonly`, `disabledInteractive`. Host bindings: `[attr.aria-invalid]="(empty && required) ? null : errorState"`, `[attr.aria-required]="required"`, `[required]`. So an empty required field has `aria-required="true"` and **no** `aria-invalid`; any other field has `aria-invalid="true|false"`.

Native select rules:
- Options from `@for`: bind `[selected]` on each `<option>`, never `[value]` on the `<select>` (otherwise the first render shows the first option). With `[formField]` on the select, plain `[value]` on the options is enough: the directive sets the select's value.
- Filters without a form: `(change)="onStatus($event)"` and read `($event.target as HTMLSelectElement).value`.
- Specs: `select.value = 'x'; select.dispatchEvent(new Event('input')); select.dispatchEvent(new Event('change'));` (Signal Forms listens to `input`, like a browser fires it). `MatNativeSelectHarness` exists too (testing.md).

Search inputs: `type="search"`; the repo hides the browser's own cancel button with `class="[&::-webkit-search-cancel-button]:appearance-none"` and shows its own `matIconButton matSuffix` clear button only while there is text (it clears, resets paging and refocuses the input).

## Autocomplete (`@angular/material/autocomplete`)

- `MatAutocompleteTrigger`: `input[matAutocomplete], textarea[matAutocomplete]` (export `matAutocompleteTrigger`). Inputs: `matAutocomplete` (the panel), `matAutocompletePosition` (`'auto' | 'above' | 'below'`), `matAutocompleteConnectedTo` (a `[matAutocompleteOrigin]`), `autocomplete` (the native attribute), `matAutocompleteDisabled`. It is a `ControlValueAccessor`, so `[formField]` binds the **selected option value** (an object here) through it.
- `MatAutocomplete`: `mat-autocomplete` (export `matAutocomplete`). Inputs: `displayWith` (value → text), `autoActiveFirstOption`, `autoSelectActiveOption`, `requireSelection` (clears typed text that isn't an option on blur), `panelWidth`, `hideSingleSelectionIndicator`, `aria-label`, `aria-labelledby`, `class`, `disableRipple`. Outputs: `optionSelected`, `opened`, `closed`, `optionActivated`.
- Options: `MatOption` (`mat-option`, `[value]`), `MatOptgroup` (`mat-optgroup`, `label`) from `@angular/material/core` (also re-exported by autocomplete).
- ARIA: the input is a `combobox` with `aria-expanded`, `aria-controls` and `aria-activedescendant`; options are `role="option"` in a `listbox`; an optgroup is `role="group"` named by its label.

Repo pattern (Reporting scope, Unallocated assign): options come from `scopeOptions`/`filterOptions` as a `computed` over what was typed (the model), grouped in `mat-optgroup` Farms/Turbines; `displayWith` shows the label; the schema has `required` + a `chooseOption` validator so typed text that isn't an option is an error (we don't use `requireSelection`, which would silently clear the text). Two `<mat-error>` branches pick the message by `field().getError('chooseOption')`.

Tokens: `--mat-autocomplete-background-color`, `-container-shape`, `-container-elevation-shadow`; options `--mat-option-*` (label colour/font, hover/focus/selected state layers), groups `--mat-optgroup-label-text-*`. The panel is an overlay in `.cdk-overlay-container`.

## Datepicker and date range (`@angular/material/datepicker`)

Adapter: `provideNativeDateAdapter(formats?)` from `@angular/material/core` in the **page's** `providers` (History, Reporting, Weather history). The native adapter parses and formats in the browser locale (en-US in tests: `1/2/2026`).

| Element | Selector | Inputs / outputs |
|---|---|---|
| `MatDateRangeInput` | `mat-date-range-input` (export `matDateRangeInput`) | `rangePicker`, `required`, `dateFilter`, `min`, `max`, `disabled`, `separator`, `comparisonStart`, `comparisonEnd` |
| `MatStartDate` / `MatEndDate` | `input[matStartDate]` / `input[matEndDate]` | `errorStateMatcher` (from `MatDateRangeInputPartBase`), `value`, `disabled`; outputs `dateChange`, `dateInput` |
| `MatDateRangePicker` / `MatDatepicker` | `mat-date-range-picker` / `mat-datepicker` | from `MatDatepickerBase`: `startAt`, `startView`, `touchUi`, `disabled`, `xPosition`, `yPosition`, `restoreFocus`, `dateClass`, `panelClass`, `opened`, `calendarHeaderComponent`; outputs `opened`, `closed`, `yearSelected`, `monthSelected`, `viewChanged` |
| `MatDatepickerInput` | `input[matDatepicker]` | `matDatepicker`, `min`, `max`, `matDatepickerFilter` |
| `MatDatepickerToggle` | `mat-datepicker-toggle` | `for`, `aria-label`, `disabled`, `tabIndex`, `disableRipple`; custom icon via `[matDatepickerToggleIcon]` |
| Actions | `mat-date-range-picker-actions` + `[matDateRangePickerApply]` / `[matDateRangePickerCancel]` | optional explicit Apply/Cancel |

Repo template (Reporting):

```html
<mat-form-field appearance="outline" subscriptSizing="dynamic" data-testid="report-range">
  <mat-label>Dates ({{ tz.tag() }})</mat-label>
  <mat-date-range-input [rangePicker]="picker" [max]="maxDate()">
    <input matStartDate placeholder="Start date" data-testid="report-from"
           [formField]="reportForm.start" [errorStateMatcher]="rangeErrorState()" />
    <input matEndDate placeholder="End date" data-testid="report-to"
           [formField]="reportForm.end" [errorStateMatcher]="rangeErrorState()" />
  </mat-date-range-input>
  <mat-datepicker-toggle matIconSuffix [for]="picker" />
  <mat-date-range-picker #picker (opened)="onPicking(true)" (closed)="onPicking(false)" />
  <mat-error>Choose the start and end dates.</mat-error>
</mat-form-field>
```

Pitfalls:
- Picking a start day sets the start **and clears the end** (two `dateChange`s). Pages track `picking` from `(opened)`/`(closed)` and don't query or show a range error while the calendar is open (`RangeErrorState` in `reporting/reporting-page.ts`; History/Weather history skip requests while picking).
- The inputs' own validators (parse, `min`/`max`, filter) are `NG_VALIDATORS` and still count with `[formField]`.
- `max` is a `Date` at the browser's local midnight; `core/days.ts` converts between that and days in the chosen zone (`pickerDate`, `zoneDayOf`).
- Toggle button accessible name: "Open calendar"; calendar days are buttons named like "January 2, 2026" inside a `role="dialog"` overlay (Playwright uses these).
- Tokens: `--mat-datepicker-calendar-*` (date states, header, container shape), `--mat-datepicker-range-input-*`, `--mat-datepicker-toggle-*`.

## Checkbox, radio, slide-toggle

| Component | Selector | Notable inputs / outputs | ARIA |
|---|---|---|---|
| `MatSlideToggle` (`@angular/material/slide-toggle`) | `mat-slide-toggle` | `checked`, `disabled`, `disabledInteractive`, `required`, `hideIcon`, `labelPosition`, `aria-label`, `aria-labelledby`, `aria-describedby`, `name`, `id`; outputs `change`, `toggleChange` | inner `<button role="switch" aria-checked>`; projected text is its `<label for>` |
| `MatCheckbox` (`@angular/material/checkbox`) | `mat-checkbox` | `checked`, `indeterminate`, `disabled`, `disabledInteractive`, `required`, `labelPosition`, `aria-*`, `value`; outputs `change`, `indeterminateChange` | native checkbox inside |
| `MatRadioGroup` / `MatRadioButton` (`@angular/material/radio`) | `mat-radio-group` / `mat-radio-button` | group: `value`, `selected`, `name`, `disabled`, `required`, `labelPosition`; output `change` | native radios; name the group with `aria-labelledby` |

All three are `ControlValueAccessor`s, so `[formField]` works on them. Repo uses: the rule editor's **Enabled** switch (`[formField]="ruleForm.enabled"`, `aria-describedby` to a hint `<p>`), per-row switches on the Rules page (`hideIcon`, `[checked]`, `[disabled]` while the PATCH is in flight, `aria-label` "Disable|Enable <rule>"), and the turbines table's Commissioned switch (`hideIcon`, `disabledInteractive` + `[disabled]` so focus stays on it while saving: clicks are ignored, and the inner button has `aria-disabled="true"`, not `disabled`; `aria-label` "Mark <turbine> as commissioned"; `[--mat-slide-toggle-touch-target-size:40px]` so the default 48px target can't reach into the next 40px row). The handler resets the control with `event.source.checked = <store value>`, and the binding then follows the store. Moving a row in the DOM drops the focus inside it: `TurbineTable.keepSwitchFocus()` reads `activeElement` in a list-change effect, which runs before the table renders, and restores focus in `afterNextRender`. Tokens: `--mat-slide-toggle-*` (82 of them; the repo sets the unselected track/icon colours and the handle/track shapes), `--mat-checkbox-*`, `--mat-radio-*`.

## Signal Forms interop (Angular 22 + Material 22.2)

How it works (verified in the installed code):
- `[formField]` is the `FormField` directive (`@angular/forms/signals`, `@publicApi 22.0`). On a native element it binds value, `disabled`, `required`, `readonly` etc. directly; on a component it uses the component's `ControlValueAccessor` (autocomplete trigger, date range parts, slide-toggle). It marks the field touched on blur and provides the `FORM_FIELD` token and an interop `NgControl`.
- `MatInput` injects `FORM_FIELD` (`{ self: true, optional: true }`) and builds its `_ErrorStateTracker` from it (falling back to `NgControl`), so its `errorState`, `aria-invalid` and the form field's red outline and `<mat-error>` follow the field state. `MatFormFieldControl` has `ngField?: Field<T> | null` for this.
- Default `ErrorStateMatcher.isSignalErrorState(field)` = `field().invalid() && field().touched()`. `ShowOnDirtyErrorStateMatcher.isSignalErrorState` = `invalid && dirty`. There is no "form submitted" state: **submitting must mark the fields touched**. `submit(form)` / a `submission` action run by `[formRoot]` does it; a plain `(submit)="run()"` handler calls `this.form().markAsTouched()` when invalid.
- A custom matcher must implement `isErrorState` (the Reactive Forms path; may simply delegate or return false) and may implement `isSignalErrorState`:

```ts
class RangeErrorState extends ErrorStateMatcher {
  constructor(private readonly picking: boolean) { super(); }
  override isErrorState(...args: Parameters<ErrorStateMatcher['isErrorState']>): boolean {
    return !this.picking && super.isErrorState(...args);
  }
  override isSignalErrorState(field: Field<unknown> | null): boolean {
    return !this.picking && !!field && field().invalid() && field().touched();
  }
}
```

- `[formRoot]="myForm"` on the `<form>` (`FormRoot`, selector `form[formRoot]`, `@publicApi 22.0`): sets `novalidate`, prevents the native submit and calls `submit()` when the form has a `submission` option (`form(model, schema, { submission: { action, onInvalid? } })`). `submit()` marks the whole tree touched first, runs `action` only when the form isn't invalid (else `onInvalid`), and returns `false` without doing anything while a submission is in flight; an `action` may return validation errors, which are set on the fields. Calling `submit(form)` on a form with no action throws (NG01915). `myForm().submitting()` drives "Saving…".
- Values derived from the model are `computed` over the model signal; no `valueChanges`/`toSignal`.
- Validators in the schema: `required`, `min`, `max`, `minLength`, `maxLength`, `pattern`, `email`, `minDate`, `maxDate`, `validate(path, ({ value }) => cond ? { kind, message? } : undefined)`, `validateTree`, `validateAsync`, `validateHttp`; cross-field rules are a `validate` on the root path, read via `form().errors()`. `disabled(path, …)`, `readonly`, `hidden` are logic rules.

## Accessibility checklist

- Every control has a visible `<mat-label>` (or `aria-labelledby` for toggles/radios); no placeholder-only labels.
- Errors say what to do ("Enter a threshold value."), live in `<mat-error>`, and appear only after touch/submit.
- Server errors go in a `role="alert"` paragraph inside the form, not in `<mat-error>`.
- Required fields: Material shows the marker and `aria-required`; don't add "(required)" text.
- A unit or format hint is in `aria-describedby`, not only in the suffix.

## Harnesses (details in testing.md)

`MatFormFieldHarness` (`getLabel`, `hasErrors`, `getTextErrors`, `isControlTouched`, `isControlValid`, `getControl`…), `MatInputHarness` (`setValue`, `getValue`, `isRequired`, `blur`), `MatNativeSelectHarness` (`selectOptions`, `getOptions`), `MatAutocompleteHarness` (`enterText`, `getOptions`, `getOptionGroups`, `selectOption`, `isOpen`), `MatDateRangeInputHarness` (`getStartInput()`/`getEndInput()` → `setValue`, `getValue`, `getMax`; `openCalendar`, `getCalendar`), `MatSlideToggleHarness` (`check`, `uncheck`, `toggle`, `isChecked`, `isDisabled`).

## Pitfalls

- Tailwind `grid`/`flex` on `mat-form-field` itself loses to Material's display: size it with width utilities (`w-72 max-w-full`) and lay out the parent.
- A harness action waits for stability; a pending `latestLoad`/`rxResource` keeps the app unstable, so `MatDateRangeInputHarness.setValue` hangs until the request is flushed. Use DOM events or `rangeCalendar(field)` (`fleet/testing.ts`) there.
- `mat-error` inside an `@if` is fine; Material only renders `mat-error` content when the control is in error state, so a branch on `getError(kind)` picks the message.
- `aria-invalid` is absent (not `"false"`) on an empty required field: assert `aria-required` there.
