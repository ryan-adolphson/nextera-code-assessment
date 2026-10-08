# Nextera Frontend E2E Test Plan

> [DATA] tests live under `tests/data/` (Playwright project `data`: one worker, runs after the parallel `read-only` project); everything else goes elsewhere under `tests/`.

## Application Overview

E2E plan for the Nextera Angular app at http://localhost:8082 (production web image, API on :8080, ingestion on :8081). Conventions: every scenario starts from tests/seed.spec.ts (browser clock fixed at 2026-01-03T00:00:00Z, signed in as admin@nextera.local, on /farms) unless it says otherwise. Intended seed data: 10 farms, TURB001/TURB002, readings every 5 min 2026-01-01T00:00Z to 2026-01-02T23:55Z, with anomalies TURB001 Jan 1 13:40-13:50 (0 kW at 15.8 m/s), TURB002 Jan 1 18:10 (44 deg pitch spike) and TURB002 Jan 2 03:20-03:30 (gearbox stuck at 126.5 C). Passwords come from the SEED_USER_PASSWORD env var and must never be written into specs. Viewer and owner scenarios sign in as viewer@nextera.local / owner@nextera.local via /login (they were planned from code, not explored live). Tests are tagged [DATA] when they change data (rule CRUD, CSV upload) and must run serially (single worker, one describe.serial) with cleanup (delete created rules, re-enable disabled rules). Prefer data-testid, roles and labels. TEST DATA: load the fixture with `npm run db:seed` (compose postgres; it is idempotent): 10 farms, 2 turbines (TURB001 on FARM01, TURB002 on FARM02, both not commissioned), readings every 5 min 2026-01-01T00:00Z to 2026-01-02T23:55Z, the three users, and NO alert rules or flagged readings (the seed does not evaluate rules, and readings stored before a rule exists are never flagged). Scenarios that need flagged readings create their rules and then upload readings through the ingestion service's CSV endpoint (http://localhost:8081/ingest/telemetry, multipart field `file`; the compose `ingestion` service must be running) at timestamps the fixture doesn't use (e.g. 2026-01-02T12:02:00Z), as [DATA] tests. Live-update scenarios need `ingestion` running too. Verify preconditions in a beforeAll.

## Test Scenarios

### 1. 1. Authentication

**Seed:** `tests/seed.spec.ts`

#### 1.1. Login page renders empty form

**File:** `tests/auth/login-render.spec.ts`

**Steps:**
  1. Start signed out (fresh context without storage). Go to /login.
    - expect: Heading 'Sign in', brand 'Nextera Wind fleet', Email and Password fields, 'Sign in' button visible
    - expect: No error shown; no side nav

#### 1.2. Required-field validation

**File:** `tests/auth/login-validation.spec.ts`

**Steps:**
  1. Signed out, on /login. Click 'Sign in' with both fields empty.
    - expect: login-email-error 'Enter your email address.' and login-password-error 'Enter your password.'
    - expect: No request to /api/auth/login and URL stays /login
  2. Type 'not-an-email' in Email, a value in Password, submit.
    - expect: Email error 'Enter a valid email address.'; password error absent; no API call

#### 1.3. Wrong password shows generic error

**File:** `tests/auth/login-wrong-password.spec.ts`

**Steps:**
  1. Signed out. Enter admin@nextera.local and a wrong password. Click 'Sign in'.
    - expect: Button briefly reads 'Signing in…'
    - expect: login-error alert 'Invalid email or password.'
    - expect: URL stays /login; localStorage has no session
  2. Repeat with an unknown email.
    - expect: Identical message (no account enumeration)

#### 1.4. Successful login lands on /farms and shows user

**File:** `tests/auth/login-success.spec.ts`

**Steps:**
  1. Signed out. Login as admin@nextera.local with SEED_USER_PASSWORD (env).
    - expect: URL /farms
    - expect: current-user-email 'admin@nextera.local', current-user-role 'Admin'
    - expect: live-status becomes 'Live' after SSE connects
  2. Reload the page.
    - expect: Session persists (still on /farms, still signed in)

#### 1.5. Email is case/whitespace tolerant

**File:** `tests/auth/login-email-normalised.spec.ts`

**Steps:**
  1. Signed out. Login with '  ADMIN@Nextera.Local ' and the correct password.
    - expect: Signed in (backend normalises email); lands on /farms

#### 1.6. Sign out

**File:** `tests/auth/sign-out.spec.ts`

**Steps:**
  1. Signed in. Click 'Sign out' (sign-out testid).
    - expect: Redirect to /login
    - expect: Session removed from localStorage
    - expect: Back button / navigating to /farms redirects to /login again

#### 1.7. Signed-out access to guarded URLs redirects to /login

**File:** `tests/auth/guarded-urls.spec.ts`

**Steps:**
  1. Signed out. Visit each of /farms, /farms/FARM01, /turbines, /alerting/history, /alerting/rules, /reporting.
    - expect: Each ends at /login
    - expect: No fleet load or /api/events request occurs before sign-in

#### 1.8. Signed-in user visiting /login is redirected

**File:** `tests/auth/login-when-signed-in.spec.ts`

**Steps:**
  1. Signed in (seed). Navigate to /login.
    - expect: URL becomes /farms (verified in exploration)

#### 1.9. Expired or invalid token signs the user out

**File:** `tests/auth/invalid-token.spec.ts`

**Steps:**
  1. Signed in. Overwrite the stored access token in localStorage with garbage (or route /api/** to 401) and navigate to /turbines.
    - expect: First API 401 triggers sign out and redirect to /login

#### 1.10. API unreachable on login

**File:** `tests/auth/login-api-down.spec.ts`

**Steps:**
  1. Signed out. Abort /api/auth/login via page.route and submit valid-looking credentials.
    - expect: login-error 'Could not reach the API. Check your connection and try again.'
  2. Mock status 429.
    - expect: 'Too many attempts. Wait a minute and try again.'

### 2. 2. Roles and permissions

**Seed:** `tests/seed.spec.ts`

#### 2.1. Viewer sees no Reporting nav item

**File:** `tests/roles/viewer-nav.spec.ts`

**Steps:**
  1. Sign out, login as viewer@nextera.local (password from env).
    - expect: current-user-role 'Viewer'
    - expect: main-nav shows Farms, Turbines, Alerting; no 'Reporting' link

#### 2.2. Viewer is blocked from /reporting

**File:** `tests/roles/viewer-reporting-blocked.spec.ts`

**Steps:**
  1. As viewer navigate directly to /reporting.
    - expect: Route guard denies; user is redirected away (to /farms) and the Reporting page is not rendered; no /api/reports request

#### 2.3. Viewer has read-only Rules page

**File:** `tests/roles/viewer-rules-readonly.spec.ts`

**Steps:**
  1. As viewer open /alerting/rules.
    - expect: Rule table visible with paging
    - expect: No 'Add rule' button, no Edit or Delete buttons per row

#### 2.4. Viewer can use read-only areas

**File:** `tests/roles/viewer-read-access.spec.ts`

**Steps:**
  1. As viewer open /farms, /turbines, a turbine page and /alerting/history.
    - expect: All load with data; live status shows Live (SSE works with viewer token)

#### 2.5. Owner sees Reporting and rule write controls

**File:** `tests/roles/owner-access.spec.ts`

**Steps:**
  1. Login as owner@nextera.local.
    - expect: Reporting nav present; /reporting loads
    - expect: /alerting/rules shows Add rule, Edit and Delete

#### 2.6. Admin sees everything

**File:** `tests/roles/admin-access.spec.ts`

**Steps:**
  1. Seed session (admin). Open nav, /reporting and /alerting/rules.
    - expect: Reporting nav present, role label 'Admin', Add rule/Edit/Delete present

#### 2.7. Viewer write attempt is rejected by API [DATA-safe]

**File:** `tests/roles/viewer-api-forbidden.spec.ts`

**Steps:**
  1. As viewer, in-page fetch POST /api/alert-configs with the stored bearer token (valid body).
    - expect: Response 404 (insufficient role is hidden as unknown route); no rule is created

### 3. 3. Farms and turbine drill-down

**Seed:** `tests/seed.spec.ts`

#### 3.1. Fleet overview shows tiles, map and farm table

**File:** `tests/farms/overview.spec.ts`

**Steps:**
  1. Open /farms.
    - expect: 'Loading fleet…' then heading 'Fleet overview'
    - expect: Tiles Fleet output, Turbines reporting 'n / n', Wind farms 10, Data as of '<date>, hh:mm UTC'
    - expect: Leaflet map renders with zoom +/- and legend (Reporting, No data in 15/30/60 min, No turbines or readings)
    - expect: Farm table (testid farms) with columns Farm, Location, Turbines, Reporting, Output (kW), Avg wind; 10 farms; farms without turbines show '–'; no paginator

#### 3.2. Click a farm row navigates to farm page

**File:** `tests/farms/farm-navigation.spec.ts`

**Steps:**
  1. On /farms click the 'Prairie Ridge' row.
    - expect: URL /farms/FARM01
    - expect: Breadcrumb back link 'All farms' (back-to-farms) visible
  2. Click 'All farms'.
    - expect: Back to /farms

#### 3.3. Farm page lists scoped turbines without Farm column

**File:** `tests/farms/farm-page.spec.ts`

**Steps:**
  1. Open /farms/FARM02.
    - expect: Map of the farm's turbines
    - expect: Turbine table (testid turbines) with no Farm column and no sort-farm header
    - expect: Count text 'n of n turbines' matches the farm

#### 3.4. Farm with no turbines

**File:** `tests/farms/farm-empty.spec.ts`

**Steps:**
  1. Open /farms/FARM03 (no turbines in current DB; in the seed use any farm without turbines).
    - expect: testid no-turbines message shown instead of a table

#### 3.5. Unknown farm and unknown turbine

**File:** `tests/farms/not-found.spec.ts`

**Steps:**
  1. Open /farms/NOPE.
    - expect: testid farm-not-found 'Farm NOPE was not found.' with back link (verified)
  2. Open /farms/FARM01/turbines/NOPE.
    - expect: testid turbine-not-found message
  3. Open /farms/FARM02/turbines/TURB001 (turbine in another farm).
    - expect: Not-found or mismatch handled without crash

#### 3.6. [SEED] Turbine page: candlestick charts per metric

**File:** `tests/farms/turbine-charts.spec.ts`

**Steps:**
  1. Open /farms/FARM01/turbines/TURB001 with fixed clock.
    - expect: Breadcrumb All farms > farm > TURB001, status pill, 'Latest reading ... UTC'
    - expect: Range toggle 6h/24h/48h/7d with 24h selected; window-end text 'Ending now (00:00 UTC)'
    - expect: One chart card per metric (power, wind, rotor speed, blade pitch, gearbox temperature) each with chart-title, latest value, candle-size note ('30 min' for 24h), stats median/high/low
    - expect: An 'Alert rules triggered' chart
  2. Switch range to 6h, 48h and 7d.
    - expect: Candle size 15 min, 1 h, 4 h respectively; charts re-render; stats update

#### 3.7. [SEED] Anomaly visible in stats and table

**File:** `tests/farms/turbine-anomalies.spec.ts`

**Steps:**
  1. Open TURB002 page with 7d range (covers Jan 1 18:10 spike and Jan 2 03:20-03:30 stuck gearbox).
    - expect: Blade pitch high stat >= 44; gearbox high stat 126.5 C
    - expect: Readings table (testid history) rows contain 18:10 and 03:20 entries
  2. Open TURB001 with 48h range.
    - expect: Power low stat 0 kW; wind high 15.8 m/s

#### 3.8. [SEED] Brush zoom and Reset zoom

**File:** `tests/farms/turbine-zoom.spec.ts`

**Steps:**
  1. On a turbine page with 48h, drag horizontally across a chart (brush).
    - expect: Every metric chart zooms to the same window; 'Reset zoom' button appears
  2. Click 'Reset zoom'.
    - expect: Full range restored on all charts; button disappears
  3. Drag the dataZoom slider handle.
    - expect: All charts follow the shared time window; crosshair is shared when hovering

#### 3.9. [SEED] Median/high/low reference lines

**File:** `tests/farms/turbine-stats-lines.spec.ts`

**Steps:**
  1. Open a turbine page and read the stats of a chart; change range.
    - expect: Median/high/low values shown with dashed reference lines; values change with range and equal values shown in readings table extrema

#### 3.10. [SEED] Readings table with Alerts pills and pagination

**File:** `tests/farms/turbine-readings-table.spec.ts`

**Steps:**
  1. On TURB002 (7d) inspect the history table.
    - expect: Columns include time, metrics, Alerts (reading-alerts) showing 'Level: count' pills worst first, tooltip listing every rule; unflagged readings show no pill
    - expect: history-paginator pages through readings; page size change works

#### 3.11. Empty window message

**File:** `tests/farms/turbine-empty-window.spec.ts`

**Steps:**
  1. Open /farms/FARM02/turbines/TURB002 in the current DB (latest reading is months before clock) or any turbine whose last reading is older than the window.
    - expect: empty-window 'No readings in the last 24 hours.' (verified), empty-window-last-reading 'Last reading: <date> UTC', link empty-window-longer 'Show the last 48 hours'; no charts
  2. Click the 'Show the last 48 hours' link.
    - expect: Range switches to 48h; message updates or charts appear

#### 3.12. Turbine not commissioned badge

**File:** `tests/farms/turbine-not-commissioned.spec.ts`

**Steps:**
  1. Open a turbine with commissioned=false (TURB001 in the current DB).
    - expect: not-commissioned badge visible; commissioned turbines have none

### 4. 4. Turbines table

**Seed:** `tests/seed.spec.ts`

#### 4.1. Table renders columns and default page

**File:** `tests/turbines/table.spec.ts`

**Steps:**
  1. Open /turbines.
    - expect: Heading 'Turbines'; filter row (text, Status, Commissioned)
    - expect: turbine-count '2 of 2 turbines' (fixture)
    - expect: Columns Turbine, Farm, Status, Commissioned, Power, Wind, Gearbox, Last reading (UTC)
    - expect: one page (25 rows per page), paginator '1 – 2 of 2'; paging itself is covered by mocking GET /api/farms with page.route

#### 4.2. Row click opens turbine page

**File:** `tests/turbines/row-navigation.spec.ts`

**Steps:**
  1. Click the TURB002 row.
    - expect: URL /farms/<farmId>/turbines/TURB002

#### 4.3. Text filter and clear button

**File:** `tests/turbines/text-filter.spec.ts`

**Steps:**
  1. Type 'TURB002' in turbine-filter.
    - expect: Only matching rows; turbine-count updates 'x of N turbines'; clear button turbine-filter-clear appears
  2. Type a farm name such as 'prairie' (case-insensitive).
    - expect: Rows of that farm match (filter is turbine or farm)
  3. Click clear.
    - expect: Filter empty, all rows back, paginator reset to page 1

#### 4.4. No matches state

**File:** `tests/turbines/no-matches.spec.ts`

**Steps:**
  1. Type 'zzzz' in the filter.
    - expect: testid no-matches message, no rows, count '0 of N turbines'
  2. Clear the filter.
    - expect: Table returns

#### 4.5. Status filter

**File:** `tests/turbines/status-filter.spec.ts`

**Steps:**
  1. Select each of Reporting, No data in 15/30/60 min, No readings yet in status-filter.
    - expect: Only rows with the matching pill; count updates; empty selection shows no-matches

#### 4.6. Commissioned filter

**File:** `tests/turbines/commissioned-filter.spec.ts`

**Steps:**
  1. Select 'Not commissioned', then 'Commissioned', then 'Any'.
    - expect: Rows show only X (or only check) in commissioned-icon; Any restores all
  2. Combine text filter + status + commissioning.
    - expect: Filters AND together; paginator resets to page 1

#### 4.7. Sorting

**File:** `tests/turbines/sorting.spec.ts`

**Steps:**
  1. Click sort-id, sort-farm, sort-status, sort-commissioned, sort-time headers, each twice.
    - expect: Row order toggles ascending/descending (aria-sort updates); sorting persists across paging

#### 4.8. Pagination

**File:** `tests/turbines/pagination.spec.ts`

**Steps:**
  1. The fixture has only 2 turbines, so mock GET /api/farms with page.route to return 50 turbines. Click Next page, change items per page to 10 and 50.
    - expect: Label '26 – 50 of 50'; Previous enabled; page size change resets to page 1; first page has Previous disabled

### 5. 5. Staleness

**Seed:** `tests/seed.spec.ts`

#### 5.1. [SEED] All turbines reporting at seed clock

**File:** `tests/staleness/reporting.spec.ts`

**Steps:**
  1. Fixed clock 2026-01-03T00:00Z. Open /turbines.
    - expect: Latest reading 2026-01-02 23:55 is 5 min old; all rows 'Reporting'; overview tile 'n / n'

#### 5.2. [SEED] Stale pills at 15/30/60 minute boundaries

**File:** `tests/staleness/thresholds.spec.ts`

**Steps:**
  1. Use page.clock to set the time to 2026-01-03T00:10Z (15 min after 23:55 is the boundary; check just before and after), 00:25, 00:55 and 01:55 (via fastForward, FleetStore ticks every minute).
    - expect: Pill goes Reporting -> 'No data in 15 min' (yellow) -> 'No data in 30 min' (orange) -> 'No data in 60 min' (red) after each threshold
    - expect: Overview 'Turbines reporting' decreases; status filter finds them; map legend colours follow

#### 5.3. Turbine page status pill follows staleness

**File:** `tests/staleness/turbine-pill.spec.ts`

**Steps:**
  1. Open TURB001 page with clock advanced 40 minutes.
    - expect: status pill 'No data in 30 min'

#### 5.4. Turbine with no readings

**File:** `tests/staleness/no-readings.spec.ts`

**Steps:**
  1. Find a turbine without telemetry (if any).
    - expect: Pill 'No readings yet'; excluded from reporting count

### 6. 6. Alerting history

**Seed:** `tests/seed.spec.ts`

#### 6.1. /alerting redirects to History; tabs navigate

**File:** `tests/alerting/tabs.spec.ts`

**Steps:**
  1. Click Alerting in the nav.
    - expect: URL /alerting/history; heading 'Alerting'; tabs History and Rules (alerting-tabs)
  2. Click Rules, then History.
    - expect: URLs /alerting/rules and /alerting/history; active tab highlighted

#### 6.2. Default date range is whole UTC days

**File:** `tests/alerting/history-default-range.spec.ts`

**Steps:**
  1. Open /alerting/history.
    - expect: history-from '1/1/2026', history-to '1/2/2026' under the fixed clock (verified)
    - expect: history-count text '<n> flagged readings on <m> turbines' (singular wording for 1)

#### 6.3. Empty state

**File:** `tests/alerting/history-empty.spec.ts`

**Steps:**
  1. Open history in the current DB (no readings were flagged) or pick a range with no alerts.
    - expect: '0 flagged readings on 0 turbines' and history-empty 'No alerts in this range.'; paginator '0 of 0' (verified)

#### 6.4. [SEED] [DATA] Flagged readings grouped by turbine

**File:** `tests/alerting/history-rows.spec.ts`

**Steps:**
  1. Setup: as owner, create two rules (e.g. Gearbox above 120 °C error, Blade pitch above 30° info), then upload a CSV with a TURB002 reading at 2026-01-02T12:02:00Z (gearbox 126.5) and one at 2026-01-01T18:12:00Z (pitch 44). Cleanup: delete the readings is not possible through the API, so disable (PATCH enabled false) the rules afterwards. Open history for 1/1/2026–1/2/2026.
    - expect: One summary row per turbine with Turbine, Farm, Latest (UTC), Alerts pills 'Error: n' / 'Warning: n' worst level first
    - expect: Counts equal sum of rules triggered across that turbine's readings
  2. Click history-expand on a row.
    - expect: Detail row shows readings (history-reading) each with level-coloured alert-chip items; toggling again collapses; multiple rows can be expanded

#### 6.5. Change date range with picker

**File:** `tests/alerting/history-picker.spec.ts`

**Steps:**
  1. Open the calendar toggle, choose a start and end day.
    - expect: Inputs show the days; loading text 'Loading alerts…' then new count; request carries whole-UTC-day from/to (end day exclusive +1)

#### 6.6. Range validation errors

**File:** `tests/alerting/history-range-errors.spec.ts`

**Steps:**
  1. Type an end date earlier than start.
    - expect: history-range-error 'The end date must not be before the start date.'; no new request
  2. Pick a range longer than 31 days (e.g. 12/1/2025 to 1/3/2026).
    - expect: 'Choose at most 31 days.'; no request
  3. Pick exactly 31 days.
    - expect: Accepted and loads
  4. Try a date after today (max date).
    - expect: Rejected by the picker

#### 6.7. History load failure and retry

**File:** `tests/alerting/history-error.spec.ts`

**Steps:**
  1. Route GET /api/alerts to 500, open history.
    - expect: history-error 'The alerts could not be loaded.' with Retry button
  2. Unroute and click history-retry.
    - expect: Table loads; error disappears

#### 6.8. [SEED] History pagination (25 turbines per page)

**File:** `tests/alerting/history-paging.spec.ts`

**Steps:**
  1. Neither seed has more than 25 turbines (fixture 2, demo 25), and only seeds create turbines, so mock GET /api/alerts with page.route to return readings for 30 turbines, then view history.
    - expect: history-paginator shows 1 – 25 of N; Next shows the remainder; expansion state does not leak across pages

### 7. 7. Alert rules (serial, mutating)

**Seed:** `tests/seed.spec.ts`

#### 7.1. Rules list renders

**File:** `tests/alerting/rules-list.spec.ts`

**Steps:**
  1. Open /alerting/rules as admin.
    - expect: Heading '<n> rules'; table columns Metric, Condition, Threshold, Level, Actions; with the fixture there are no rules ('0 rules' and the empty state); after creating one, a row like 'Power output (kW) | below | 100 kW | Warning'; edit/delete buttons labelled 'Edit rule: ...'; paginator '1 – n of n'
    - expect: Add rule button (add-rule) visible

#### 7.2. [DATA] Create a rule

**File:** `tests/alerting/rules-create.spec.ts`

**Steps:**
  1. Click Add rule.
    - expect: Dialog 'Add alert rule' with Metric, Condition, Threshold (unit suffix follows metric), Level, Cancel and 'Add rule' buttons
  2. Select Wind speed, Condition above, Threshold 30, Level Info, click Add rule.
    - expect: Dialog closes; rules-notice confirms; table lists 'Wind speed above 30 m/s Info'; count increments
  3. Cleanup: delete that rule.
    - expect: Rule removed, count restored

#### 7.3. Create validation: empty and invalid threshold

**File:** `tests/alerting/rules-validation.spec.ts`

**Steps:**
  1. Open Add rule, clear threshold, press Add rule.
    - expect: rule-value-error shown; dialog stays open; no request
  2. Enter negative / out-of-range / 'e' values.
    - expect: Error or API 400 message surfaced in rule-error (class-validator messages joined by '. ')
  3. Press Cancel.
    - expect: Dialog closes, nothing created

#### 7.4. [DATA] Duplicate rule gives 409 message

**File:** `tests/alerting/rules-duplicate.spec.ts`

**Steps:**
  1. Add rule: Gearbox temperature above 99 Warning twice (second attempt).
    - expect: rule-error 'A Warning rule for “Gearbox temperature above” already exists. Edit that rule, or choose another condition or level.'; dialog remains open
  2. Cleanup: cancel and delete the created rule.
    - expect: Only the original rules remain

#### 7.5. [DATA] Edit a rule

**File:** `tests/alerting/rules-edit.spec.ts`

**Steps:**
  1. Create temp rule 'Rotor speed above 25 Info', click its Edit button.
    - expect: Dialog 'Edit alert rule' prefilled; button 'Save changes'
  2. Change threshold to 26 and Level to Warning, save.
    - expect: Row updates to 26 / Warning
  3. Cleanup: delete the rule.
    - expect: Removed

#### 7.6. [DATA] Edit collides with an existing rule

**File:** `tests/alerting/rules-edit-conflict.spec.ts`

**Steps:**
  1. Create two rules same metric/condition with different levels; edit one to the other's level.
    - expect: Duplicate message appears in dialog; nothing saved
  2. Cleanup: delete both.
    - expect: Restored

#### 7.7. [DATA] Disable and re-enable a rule

**File:** `tests/alerting/rules-toggle.spec.ts`

**Steps:**
  1. Locate the enable/disable control for a temp rule (inspect the row/Edit dialog; the current UI exposes enabled only if present) and disable it.
    - expect: Row shows disabled state; rule kept; ingestion no longer evaluates it
  2. Re-enable it, then delete it.
    - expect: State returns to enabled; cleaned up

#### 7.8. [DATA] Delete an unused rule

**File:** `tests/alerting/rules-delete.spec.ts`

**Steps:**
  1. Create temp rule; click Delete rule on it.
    - expect: Confirm dialog naming the rule; confirm-delete button
  2. Cancel.
    - expect: Rule remains
  3. Delete again and confirm.
    - expect: Rule gone; count decrements

#### 7.9. [DATA][SEED] Delete a rule triggered by readings returns 409

**File:** `tests/alerting/rules-delete-conflict.spec.ts`

**Steps:**
  1. Precondition: a rule that readings have triggered (e.g. Gearbox above 55 C after TURB002 anomalies ingested). Click Delete and confirm.
    - expect: delete-error shows API conflict message advising to disable instead; dialog stays open; rule still listed
  2. Cancel the dialog. Do NOT delete the rule.
    - expect: Rule intact; no cleanup needed

#### 7.10. Rules API failure

**File:** `tests/alerting/rules-errors.spec.ts`

**Steps:**
  1. Route GET /api/alert-configs to 500 and open the Rules page.
    - expect: rules-load-error shown
  2. Route POST to abort and try Add rule.
    - expect: rule-error 'Could not reach the API. Check your connection and try again.'; Save button re-enabled

#### 7.11. Empty rules list and rules pagination

**File:** `tests/alerting/rules-empty-paging.spec.ts`

**Steps:**
  1. Mock GET /api/alert-configs to [] and then to 30 rules.
    - expect: testid no-rules message; with 30 rules rules-paginator shows 1 – 25 of 30

### 8. 8. Reporting

**Seed:** `tests/seed.spec.ts`

#### 8.1. Report form renders

**File:** `tests/reporting/form.spec.ts`

**Steps:**
  1. Open /reporting as admin (or owner).
    - expect: Heading 'Reporting'; report-scope with placeholder 'e.g. Prairie Ridge or TURB001'; report-range; Run report enabled; Download CSV disabled; no report yet

#### 8.2. Required-field validation

**File:** `tests/reporting/validation.spec.ts`

**Steps:**
  1. Click Run report with empty form.
    - expect: 'Choose a farm or turbine.' and 'Choose the start and end dates.' errors; no API request
  2. Type free text 'abc' in scope and valid dates, Run.
    - expect: 'Choose a farm or turbine from the list.'

#### 8.3. Autocomplete groups Farms and Turbines

**File:** `tests/reporting/autocomplete.spec.ts`

**Steps:**
  1. Focus scope input.
    - expect: Options in group 'Farms' and group 'Turbines'
  2. Type 'Prairie'.
    - expect: Only Farms group with Prairie Ridge
  3. Type 'TURB001'.
    - expect: Only Turbines group with matching option
  4. Type 'zzz'.
    - expect: No options

#### 8.4. [SEED] Turbine report for 2 days

**File:** `tests/reporting/turbine-report.spec.ts`

**Steps:**
  1. Pick TURB001, dates 1/1/2026 - 1/2/2026, Run report.
    - expect: 'Loading report…' then status 'TURB001 · <name>, Jan 1, 2026 – Jan 2, 2026 (UTC)'
    - expect: Summary tiles incl. Readings 576 (2 days x 288)
    - expect: One line chart per metric and an alerts chart
    - expect: report-table rows, report-paginator; row alerts pills (report-row-alerts)

#### 8.5. [SEED] Farm report aggregates

**File:** `tests/reporting/farm-report.spec.ts`

**Steps:**
  1. Pick farm Prairie Ridge, range Jan 1-2, Run.
    - expect: Status shows 'Prairie Ridge (FARM01)'; power chart is summed, others averaged; table includes all farm turbines' readings

#### 8.6. Range rules (31 day max, order)

**File:** `tests/reporting/range.spec.ts`

**Steps:**
  1. Choose 32 days.
    - expect: report-range-error 'Choose at most 31 days.'; no request
  2. Choose exactly 31 days ending 1/3/2026 or earlier.
    - expect: Request is sent
  3. Choose end before start / date after today.
    - expect: Error or picker rejects

#### 8.7. Empty report

**File:** `tests/reporting/empty.spec.ts`

**Steps:**
  1. Run a report for a farm/turbine and dates with no readings (e.g. 12/1/2025 - 12/2/2025).
    - expect: report-empty 'No readings in this range.'; Download CSV disabled; no charts

#### 8.8. [SEED] CSV download

**File:** `tests/reporting/csv.spec.ts`

**Steps:**
  1. Run turbine report, click Download CSV with waitForEvent('download').
    - expect: File named after scope and days; header = telemetry.csv columns + alerts; one row per reading; anomalous rows (13:40 0 kW) included

#### 8.9. Report error and retry

**File:** `tests/reporting/error.spec.ts`

**Steps:**
  1. Route /api/reports/telemetry to 500, run report.
    - expect: report-error 'The report could not be loaded.' with Retry
  2. Unroute, click report-retry.
    - expect: Report loads

#### 8.10. Report table pagination

**File:** `tests/reporting/paging.spec.ts`

**Steps:**
  1. After a 2-day report, use report-paginator Next and change page size.
    - expect: Row counts and range label update; chart unaffected

### 9. 9. Live updates (SSE)

**Seed:** `tests/seed.spec.ts`

#### 9.1. Live status indicator

**File:** `tests/live/status.spec.ts`

**Steps:**
  1. Open /farms.
    - expect: live-status first 'Connecting…' then 'Live'
  2. Block /api/events (route abort) and reload.
    - expect: Status shows a reconnecting/disconnected state (verify exact text) and recovers when unblocked

#### 9.2. [DATA] CSV upload updates tables without reload

**File:** `tests/live/upload-updates.spec.ts`

**Steps:**
  1. Open /turbines and note TURB001's Last reading. In the test, POST a one-row telemetry.csv (multipart field 'file', new timestamp, e.g. 2026-01-03T00:05:00Z) to http://localhost:8081/ingest/telemetry using request context.
    - expect: Upload returns success (1 inserted)
    - expect: Without reload, the TURB001 row's Last reading and values update; farm tile 'Data as of' updates
  2. Open TURB001 page, upload another reading.
    - expect: Latest reading label, charts and readings table gain the new row
  3. Cleanup: the reading cannot be deleted via UI; run on a disposable DB or use a distinct timestamp and document it.
    - expect: Serial execution only

#### 9.3. [DATA] Uploaded anomaly flags alerts live

**File:** `tests/live/upload-alert.spec.ts`

**Steps:**
  1. With rules Gearbox above 55 C present, upload a reading with gearbox 126.5 for TURB002.
    - expect: Turbine page readings table shows an Alerts pill 'Warning: 1' without reload; History (re-run range) shows TURB002 with the chip

#### 9.4. [DATA] Stale turbine recovers on new reading

**File:** `tests/live/staleness-recovery.spec.ts`

**Steps:**
  1. Advance the clock 40 min so TURB001 reads 'No data in 30 min', then upload a reading with a current timestamp.
    - expect: Pill returns to 'Reporting' without reload

#### 9.5. [DATA] Rule change event refreshes rules

**File:** `tests/live/rule-changed.spec.ts`

**Steps:**
  1. Open /alerting/rules in page A, create a rule via API or page B, cleanup after.
    - expect: Page A updates the list without reload (alert-config.changed event); verify behaviour

#### 9.6. Invalid CSV upload is rejected and UI unchanged

**File:** `tests/live/upload-invalid.spec.ts`

**Steps:**
  1. POST a CSV with an invalid row to the ingestion endpoint.
    - expect: 400 with line-based errors; nothing stored; open pages show no change

### 10. 10. Navigation and layout

**Seed:** `tests/seed.spec.ts`

#### 10.1. Desktop side nav

**File:** `tests/nav/desktop.spec.ts`

**Steps:**
  1. Viewport 1280x800, open /farms.
    - expect: Sidebar (testid sidebar) is a left column with brand, live-status, main-nav links Farms, Turbines, Alerting, Reporting, user block and Sign out; nav-toggle hidden
    - expect: Skip to content link focuses main content on keyboard Tab/Enter
  2. Click each nav link.
    - expect: URLs /turbines, /alerting(/history), /reporting, /farms; active link highlighted (aria-current)

#### 10.2. Nav highlights parent section on deep routes

**File:** `tests/nav/active-state.spec.ts`

**Steps:**
  1. Open a turbine page /farms/FARM01/turbines/TURB001 and /alerting/rules.
    - expect: Farms resp. Alerting remains active

#### 10.3. Phone top bar with menu toggle

**File:** `tests/nav/phone.spec.ts`

**Steps:**
  1. Viewport 375x700, open /farms.
    - expect: Top bar with nav-toggle; links are collapsed
  2. Click nav-toggle.
    - expect: main-nav expands; aria-expanded true
  3. Click 'Turbines'.
    - expect: Navigates to /turbines and menu closes
  4. Resize back to desktop.
    - expect: Sidebar column returns

#### 10.4. Phone tables and charts remain usable

**File:** `tests/nav/phone-content.spec.ts`

**Steps:**
  1. At 375px open /turbines, a turbine page and /alerting/history.
    - expect: No page-level horizontal overflow; tables scroll within their frame; paginators reachable

#### 10.5. Unknown URLs redirect to /farms

**File:** `tests/nav/unknown-url.spec.ts`

**Steps:**
  1. Signed in, open /nope/xyz and /.
    - expect: Both end at /farms (verified)

#### 10.6. Browser back/forward and deep links

**File:** `tests/nav/history.spec.ts`

**Steps:**
  1. Navigate farms -> farm -> turbine, use back twice, forward once.
    - expect: Each URL and view restored without full reload; deep-link to turbine URL with a fresh load works after sign-in

#### 10.7. Page titles

**File:** `tests/nav/titles.spec.ts`

**Steps:**
  1. Visit each page.
    - expect: Titles: 'Fleet overview · Nextera', 'Turbines · Nextera', 'Alert history · Nextera', 'Alert rules · Nextera', 'Farm · Nextera', 'Turbine · Nextera' (verified for several)
