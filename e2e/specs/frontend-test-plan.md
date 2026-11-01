# Nextera Frontend E2E Test Plan

> [DATA] tests live under `tests/data/` (Playwright project `data`: one worker, runs after the parallel `read-only` project); everything else goes elsewhere under `tests/`.

## Application Overview

E2E plan for the Nextera Angular app at http://localhost:8082 (production web image, API on :8080, ingestion on :8081). Conventions: every scenario starts from tests/seed.spec.ts (browser clock fixed at 2026-01-03T00:00:00Z, signed in as admin@nextera.local, on /farms) unless it says otherwise. Intended seed data: 10 farms, TURB001/TURB002, readings every 5 min 2026-01-01T00:00Z to 2026-01-02T23:55Z, with anomalies TURB001 Jan 1 13:40-13:50 (0 kW at 15.8 m/s), TURB002 Jan 1 18:10 (44 deg pitch spike) and TURB002 Jan 2 03:20-03:30 (gearbox stuck at 126.5 C). Passwords come from the SEED_USER_PASSWORD env var and must never be written into specs. Viewer and owner scenarios sign in as viewer@nextera.local / owner@nextera.local via /login (they were planned from code, not explored live). Tests are tagged [DATA] when they change data (rule CRUD, CSV upload) and must run serially (single worker, one describe.serial) with cleanup (delete created rules, re-enable disabled rules). Prefer data-testid, roles and labels. TEST DATA: load the fixture with `npm run db:seed` (compose postgres; it is idempotent): 10 farms, 2 turbines (TURB001 on FARM01, TURB002 on FARM02, both not commissioned), readings every 5 min 2026-01-01T00:00Z to 2026-01-02T23:55Z, the three users, and NO alert rules or flagged readings (the seed does not evaluate rules, and readings stored before a rule exists are never flagged). Scenarios that need flagged readings create their rules and then upload readings through the ingestion service's CSV endpoint (http://localhost:8081/ingest/telemetry, multipart field `file`; the compose `ingestion` service must be running) at timestamps the fixture doesn't use (e.g. 2026-01-02T12:02:00Z), as [DATA] tests. Live-update scenarios need `ingestion` running too. Verify preconditions in a beforeAll.

## Automation status

121 tests in 20 files (read-only project 95, data project 26; `npx playwright test --list`). Every scenario below has a **Status** line. Wall time for both projects locally: about 38 s.

| Area | Files |
|---|---|
| 1 Authentication | `tests/auth/login.spec.ts`, `tests/auth/session.spec.ts` |
| 2 Roles, 10 Navigation | `tests/roles/roles.spec.ts` |
| 3 Farms and turbine page | `tests/farms/overview.spec.ts`, `tests/farms/turbine-page.spec.ts` |
| 4 Turbines table | `tests/turbines/turbine-table.spec.ts` |
| 5 Staleness | `tests/staleness/staleness.spec.ts` (+ overview and Turbines) |
| 6 Alerting history | `tests/alerting/history.spec.ts`, `tests/data/live.spec.ts` |
| 7 Alert rules | `tests/alerting/rules.spec.ts`, `tests/data/rules.spec.ts`, `tests/data/live.spec.ts` |
| 8 Reporting | `tests/reporting/reporting.spec.ts`, `tests/data/live.spec.ts` |
| 9 Live updates | `tests/live/status.spec.ts`, `tests/data/live.spec.ts`, `tests/data/rules.spec.ts` |
| 11 Unallocated | `tests/unallocated/access.spec.ts`, `tests/data/unallocated.spec.ts`, `tests/data/unallocated-time-zone.spec.ts` |
| 12 Time zone | `tests/settings/time-zone.spec.ts`, `tests/data/unallocated-time-zone.spec.ts` |
| 13 Weather | `tests/weather/weather.spec.ts`, `tests/weather/weather-history.spec.ts` |

Shared helpers: `tests/support/session.ts` (sign-in, SEED_NOW, API token), `clock.ts` (`fixBrowserDate`, `shortTimeIn`), `fleet.ts` (GET /api/farms from the page's own response, `mainNav`, `createTurbine`: held upload + assign), `rules.ts` (`ensureRule` / `removeRules`), `telemetry.ts`, `unallocated.ts`, `weather.ts`.

**Robust to a shared DB** (db:seed fixture plus db:seed:demo, the demo feed and earlier runs): expectations come from the responses the page rendered; turbine history/stats are bounded at the browser clock (`boundTelemetryAt`); the SSE stream is aborted in read-only tests that must not change mid-test; [DATA] tests use per-run turbine ids and clean up rules and unallocated entries (turbines and readings can't be deleted through the API: each run leaves `E2E-<run>-LV` on FARM04 with 4 Jan 2 readings and `E2E-<run>-RF` on FARM04 with 3, and the disabled rules "Rotor speed above 50 rpm → Warning" and "Gearbox temperature below 5 °C → Info", besides what section 11 leaves). `page.route` mocks only where real data can't reach the state: Turbines paging (60 turbines), History paging/chips in read-only (30 flagged turbines), an empty farm when every farm has turbines, error/Retry, a failed rule switch (PATCH 500) and login 429/unreachable, the SSE transport, and weather (section 13).

### Not automated (and why)

- 1.3 the transient 'Signing in…' label; 3.10/8.10 page-size changes on the readings tables; 4.7 the remaining sort headers; 7.6 edit-into-duplicate (same 409 path as 7.4); 7.11 rules paging; 10.1 the skip link; 10.4 phone layouts beyond /turbines.
- 12.6 and 13.14 below (DST days and +5:30 zones, storage errors, chart tick labels in local time, weather gaps and loading blocks).
- A zone change while a page is open: unreachable through the UI (Settings is its own route and the setting isn't synced across tabs), so the in-place re-query is covered by the unit specs only.

## Test Scenarios

### 1. 1. Authentication

**Seed:** `tests/seed.spec.ts`

#### 1.1. Login page renders empty form

**File:** `tests/auth/login.spec.ts`

**Status:** Automated.

**Steps:**
  1. Start signed out (fresh context without storage). Go to /login.
    - expect: Heading 'Sign in', brand 'Nextera Wind fleet', Email and Password fields, 'Sign in' button visible
    - expect: No error shown; no side nav

#### 1.2. Required-field validation

**File:** `tests/auth/login.spec.ts`

**Status:** Automated.

**Steps:**
  1. Signed out, on /login. Click 'Sign in' with both fields empty.
    - expect: login-email-error 'Enter your email address.' and login-password-error 'Enter your password.'
    - expect: No request to /api/auth/login and URL stays /login
  2. Type 'not-an-email' in Email, a value in Password, submit.
    - expect: Email error 'Enter a valid email address.'; password error absent; no API call

#### 1.3. Wrong password shows generic error

**File:** `tests/auth/login.spec.ts`

**Status:** Automated (the brief 'Signing in…' state is not asserted: too short to observe reliably).

**Steps:**
  1. Signed out. Enter admin@nextera.local and a wrong password. Click 'Sign in'.
    - expect: Button briefly reads 'Signing in…'
    - expect: login-error alert 'Invalid email or password.'
    - expect: URL stays /login; localStorage has no session
  2. Repeat with an unknown email.
    - expect: Identical message (no account enumeration)

#### 1.4. Successful login lands on /farms and shows user

**File:** `tests/auth/login.spec.ts`

**Status:** Automated (together with 1.5).

**Steps:**
  1. Signed out. Login as admin@nextera.local with SEED_USER_PASSWORD (env).
    - expect: URL /farms
    - expect: current-user-email 'admin@nextera.local', current-user-role 'Admin'
    - expect: live-status becomes 'Live' after SSE connects
  2. Reload the page.
    - expect: Session persists (still on /farms, still signed in)

#### 1.5. Email is case/whitespace tolerant

**File:** `tests/auth/login.spec.ts`

**Status:** Automated.

**Steps:**
  1. Signed out. Login with '  ADMIN@Nextera.Local ' and the correct password.
    - expect: Signed in (backend normalises email); lands on /farms

#### 1.6. Sign out

**File:** `tests/auth/session.spec.ts`

**Status:** Automated.

**Steps:**
  1. Signed in. Click 'Sign out' (sign-out testid).
    - expect: Redirect to /login
    - expect: Session removed from localStorage
    - expect: Back button / navigating to /farms redirects to /login again

#### 1.7. Signed-out access to guarded URLs redirects to /login

**File:** `tests/auth/session.spec.ts`

**Status:** Automated (also /unallocated/pending and /settings; asserts `?returnUrl=` and that signing in returns to the deep link).

**Steps:**
  1. Signed out. Visit each of /farms, /farms/FARM01, /turbines, /alerting/history, /alerting/rules, /reporting.
    - expect: Each ends at /login
    - expect: No fleet load or /api/events request occurs before sign-in

#### 1.8. Signed-in user visiting /login is redirected

**File:** `tests/auth/session.spec.ts`

**Status:** Automated.

**Steps:**
  1. Signed in (seed). Navigate to /login.
    - expect: URL becomes /farms (verified in exploration)

#### 1.9. Expired or invalid token signs the user out

**File:** `tests/auth/session.spec.ts`

**Status:** Automated (garbage token → real API 401 → /login; plus the 24 h session end with `page.clock`).

**Steps:**
  1. Signed in. Overwrite the stored access token in localStorage with garbage (or route /api/** to 401) and navigate to /turbines.
    - expect: First API 401 triggers sign out and redirect to /login

#### 1.10. API unreachable on login

**File:** `tests/auth/login.spec.ts`

**Status:** Automated.

**Steps:**
  1. Signed out. Abort /api/auth/login via page.route and submit valid-looking credentials.
    - expect: login-error 'Could not reach the API. Check your connection and try again.'
  2. Mock status 429.
    - expect: 'Too many attempts. Wait a minute and try again.'

### 2. 2. Roles and permissions

**Seed:** `tests/seed.spec.ts`

#### 2.1. Viewer sees no Reporting nav item

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated (exact nav items per role; also 11.1 for Unallocated).

**Steps:**
  1. Sign out, login as viewer@nextera.local (password from env).
    - expect: current-user-role 'Viewer'
    - expect: main-nav shows Farms, Turbines, Alerting; no 'Reporting' link

#### 2.2. Viewer is blocked from /reporting

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated.

**Steps:**
  1. As viewer navigate directly to /reporting.
    - expect: Route guard denies; user is redirected away (to /farms) and the Reporting page is not rendered; no /api/reports request

#### 2.3. Viewer has read-only Rules page

**File:** `tests/roles/roles.spec.ts`, `tests/data/rules.spec.ts`

**Status:** Automated (read-only: the fixture has no rules, so the viewer empty-state wording; [DATA]: a viewer on a real rule has no buttons).

**Steps:**
  1. As viewer open /alerting/rules.
    - expect: Rule table visible with paging
    - expect: No 'Add rule' button, no Edit or Delete buttons per row

#### 2.4. Viewer can use read-only areas

**File:** `tests/farms/overview.spec.ts`, `tests/turbines/turbine-table.spec.ts`, `tests/alerting/history.spec.ts`, `tests/live/status.spec.ts`

**Status:** Automated (these sign in as viewer; Live with a viewer token).

**Steps:**
  1. As viewer open /farms, /turbines, a turbine page and /alerting/history.
    - expect: All load with data; live status shows Live (SSE works with viewer token)

#### 2.5. Owner sees Reporting and rule write controls

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated.

**Steps:**
  1. Login as owner@nextera.local.
    - expect: Reporting nav present; /reporting loads
    - expect: /alerting/rules shows Add rule, Edit and Delete

#### 2.6. Admin sees everything

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated.

**Steps:**
  1. Seed session (admin). Open nav, /reporting and /alerting/rules.
    - expect: Reporting nav present, role label 'Admin', Add rule/Edit/Delete present

#### 2.7. Viewer write attempt is rejected by API [DATA-safe]

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated (through the API request context, not an in-page fetch).

**Steps:**
  1. As viewer, in-page fetch POST /api/alert-configs with the stored bearer token (valid body).
    - expect: Response 404 (insufficient role is hidden as unknown route); no rule is created

### 3. 3. Farms and turbine drill-down

**Seed:** `tests/seed.spec.ts`

#### 3.1. Fleet overview shows tiles, map and farm table

**File:** `tests/farms/overview.spec.ts`

**Status:** Automated (tiles, table and map markers derived from the GET /api/farms response; 'Loading fleet…' and the 'Data as of' tile are not asserted).

**Steps:**
  1. Open /farms.
    - expect: 'Loading fleet…' then heading 'Fleet overview'
    - expect: Tiles Fleet output, Turbines reporting 'n / n', Wind farms 10, Data as of '<date>, hh:mm UTC'
    - expect: Leaflet map renders with zoom +/- and legend (Reporting, No data in 15/30/60 min, No turbines or readings)
    - expect: Farm table (testid farms) with columns Farm, Location, Turbines, Reporting, Output (kW), Avg wind; 10 farms; farms without turbines show '–'; no paginator

#### 3.2. Click a farm row navigates to farm page

**File:** `tests/farms/overview.spec.ts`

**Status:** Automated (row click, a map marker click, All farms).

**Steps:**
  1. On /farms click the 'Prairie Ridge' row.
    - expect: URL /farms/FARM01
    - expect: Breadcrumb back link 'All farms' (back-to-farms) visible
  2. Click 'All farms'.
    - expect: Back to /farms

#### 3.3. Farm page lists scoped turbines without Farm column

**File:** `tests/farms/overview.spec.ts`

**Status:** Automated.

**Steps:**
  1. Open /farms/FARM02.
    - expect: Map of the farm's turbines
    - expect: Turbine table (testid turbines) with no Farm column and no sort-farm header
    - expect: Count text 'n of n turbines' matches the farm

#### 3.4. Farm with no turbines

**File:** `tests/farms/overview.spec.ts`

**Status:** Automated (with db:seed:demo every farm has turbines: the real response is then passed on with one farm emptied).

**Steps:**
  1. Open /farms/FARM03 (no turbines in current DB; in the seed use any farm without turbines).
    - expect: testid no-turbines message shown instead of a table

#### 3.5. Unknown farm and unknown turbine

**File:** `tests/farms/turbine-page.spec.ts`

**Status:** Automated: a turbine on another farm says 'Turbine TURB001 was not found on FARM02.'.

**Steps:**
  1. Open /farms/NOPE.
    - expect: testid farm-not-found 'Farm NOPE was not found.' with back link (verified)
  2. Open /farms/FARM01/turbines/NOPE.
    - expect: testid turbine-not-found message
  3. Open /farms/FARM02/turbines/TURB001 (turbine in another farm).
    - expect: Not-found or mismatch handled without crash

#### 3.6. [SEED] Turbine page: candlestick charts per metric

**File:** `tests/farms/turbine-page.spec.ts`

**Status:** Automated (each range button: the telemetry and stats requests carry from = now − range and limit = min(range/5 min + 1, 2016); candle sizes 15 min / 30 min / 1 h / 4 h; the chart summaries count the returned readings).

**Steps:**
  1. Open /farms/FARM01/turbines/TURB001 with fixed clock.
    - expect: Breadcrumb All farms > farm > TURB001, status pill, 'Latest reading ... UTC'
    - expect: Range toggle 6h/24h/48h/7d with 24h selected; window-end text 'Ending now (00:00 UTC)'
    - expect: One chart card per metric (power, wind, rotor speed, blade pitch, gearbox temperature) each with chart-title, latest value, candle-size note ('30 min' for 24h), stats median/high/low
    - expect: An 'Alert rules triggered' chart
  2. Switch range to 6h, 48h and 7d.
    - expect: Candle size 15 min, 1 h, 4 h respectively; charts re-render; stats update

#### 3.7. [SEED] Anomaly visible in stats and table

**File:** `tests/farms/turbine-page.spec.ts`

**Status:** Automated (48h at SEED_NOW: TURB002 pitch high 44.0°, gearbox high 126.5 °C; TURB001 power low 0 kW, wind high 15.8 m/s; the readings-table rows of the anomalies are not asserted).

**Steps:**
  1. Open TURB002 page with 7d range (covers Jan 1 18:10 spike and Jan 2 03:20-03:30 stuck gearbox).
    - expect: Blade pitch high stat >= 44; gearbox high stat 126.5 C
    - expect: Readings table (testid history) rows contain 18:10 and 03:20 entries
  2. Open TURB001 with 48h range.
    - expect: Power low stat 0 kW; wind high 15.8 m/s

#### 3.8. [SEED] Brush zoom and Reset zoom

**File:** `tests/farms/turbine-page.spec.ts`, `tests/weather/weather-history.spec.ts`

**Status:** Automated (brush on one chart → every chart shows the same zoomed x axis, Reset zoom restores it; a range change clears the zoom; the shared crosshair selects the same candle on every chart. Slider drag is covered on the Weather history charts).

**Steps:**
  1. On a turbine page with 48h, drag horizontally across a chart (brush).
    - expect: Every metric chart zooms to the same window; 'Reset zoom' button appears
  2. Click 'Reset zoom'.
    - expect: Full range restored on all charts; button disappears
  3. Drag the dataZoom slider handle.
    - expect: All charts follow the shared time window; crosshair is shared when hovering

#### 3.9. [SEED] Median/high/low reference lines

**File:** `tests/farms/turbine-page.spec.ts`

**Status:** Automated (median/high/low equal GET …/telemetry/stats, which covers exactly the listed rows).

**Steps:**
  1. Open a turbine page and read the stats of a chart; change range.
    - expect: Median/high/low values shown with dashed reference lines; values change with range and equal values shown in readings table extrema

#### 3.10. [SEED] Readings table with Alerts pills and pagination

**File:** `tests/farms/turbine-page.spec.ts`, `tests/data/live.spec.ts`

**Status:** Automated (columns, newest first, paging; the 'Warning: 1' pill and its tooltip on a real flagged reading in [DATA]; the page-size change is not).

**Steps:**
  1. On TURB002 (7d) inspect the history table.
    - expect: Columns include time, metrics, Alerts (reading-alerts) showing 'Level: count' pills worst first, tooltip listing every rule; unflagged readings show no pill
    - expect: history-paginator pages through readings; page size change works

#### 3.11. Empty window message

**File:** `tests/farms/turbine-page.spec.ts`

**Status:** Automated (clock Jan 4: 24 h empty, Show the last 48 hours brings the charts back).

**Steps:**
  1. Open /farms/FARM02/turbines/TURB002 in the current DB (latest reading is months before clock) or any turbine whose last reading is older than the window.
    - expect: empty-window 'No readings in the last 24 hours.' (verified), empty-window-last-reading 'Last reading: <date> UTC', link empty-window-longer 'Show the last 48 hours'; no charts
  2. Click the 'Show the last 48 hours' link.
    - expect: Range switches to 48h; message updates or charts appear

#### 3.12. Turbine not commissioned badge

**File:** `tests/farms/turbine-page.spec.ts`

**Status:** Automated (TURB001 is not commissioned in both seeds; the absence for a commissioned turbine is not asserted).

**Steps:**
  1. Open a turbine with commissioned=false (TURB001 in the current DB).
    - expect: not-commissioned badge visible; commissioned turbines have none

### 4. 4. Turbines table

**Seed:** `tests/seed.spec.ts`

#### 4.1. Table renders columns and default page

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated (sorted by id; turbines without readings are not moved last on the id sort, only on value columns).

**Steps:**
  1. Open /turbines.
    - expect: Heading 'Turbines'; filter row (text, Status, Commissioned)
    - expect: turbine-count '2 of 2 turbines' (fixture)
    - expect: Columns Turbine, Farm, Status, Commissioned, Power, Wind, Gearbox, Last reading (UTC)
    - expect: one page (25 rows per page), paginator '1 – 2 of 2'; paging itself is covered by mocking GET /api/farms with page.route

#### 4.2. Row click opens turbine page

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated.

**Steps:**
  1. Click the TURB002 row.
    - expect: URL /farms/<farmId>/turbines/TURB002

#### 4.3. Text filter and clear button

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated.

**Steps:**
  1. Type 'TURB002' in turbine-filter.
    - expect: Only matching rows; turbine-count updates 'x of N turbines'; clear button turbine-filter-clear appears
  2. Type a farm name such as 'prairie' (case-insensitive).
    - expect: Rows of that farm match (filter is turbine or farm)
  3. Click clear.
    - expect: Filter empty, all rows back, paginator reset to page 1

#### 4.4. No matches state

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated.

**Steps:**
  1. Type 'zzzz' in the filter.
    - expect: testid no-matches message, no rows, count '0 of N turbines'
  2. Clear the filter.
    - expect: Table returns

#### 4.5. Status filter

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated (Reporting, No data in 60 min, No readings yet; counts from the response).

**Steps:**
  1. Select each of Reporting, No data in 15/30/60 min, No readings yet in status-filter.
    - expect: Only rows with the matching pill; count updates; empty selection shows no-matches

#### 4.6. Commissioned filter

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated.

**Steps:**
  1. Select 'Not commissioned', then 'Commissioned', then 'Any'.
    - expect: Rows show only X (or only check) in commissioned-icon; Any restores all
  2. Combine text filter + status + commissioning.
    - expect: Filters AND together; paginator resets to page 1

#### 4.7. Sorting

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated (Turbine twice, Farm, Power twice; Status/Commissioned/Last reading headers are not clicked).

**Steps:**
  1. Click sort-id, sort-farm, sort-status, sort-commissioned, sort-time headers, each twice.
    - expect: Row order toggles ascending/descending (aria-sort updates); sorting persists across paging

#### 4.8. Pagination

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Automated (60 generated turbines; a page-size change keeps the first visible row in view, as Material does: page 26–50 at size 10 shows 21–30; a filter returns to page 1).

**Steps:**
  1. The fixture has only 2 turbines, so mock GET /api/farms with page.route to return 50 turbines. Click Next page, change items per page to 10 and 50.
    - expect: Label '26 – 50 of 50'; Previous enabled; page size change resets to page 1; first page has Previous disabled

### 5. 5. Staleness

**Seed:** `tests/seed.spec.ts`

#### 5.1. [SEED] All turbines reporting at seed clock

**File:** `tests/farms/overview.spec.ts`

**Status:** Automated (reporting count derived per turbine at the fixed clock).

**Steps:**
  1. Fixed clock 2026-01-03T00:00Z. Open /turbines.
    - expect: Latest reading 2026-01-02 23:55 is 5 min old; all rows 'Reporting'; overview tile 'n / n'

#### 5.2. [SEED] Stale pills at 15/30/60 minute boundaries

**File:** `tests/staleness/staleness.spec.ts`

**Status:** Automated (`page.clock.install`, clock set relative to TURB001’s latest reading in the response: exactly 15:00 is still Reporting, 16/31/61 min flip to 15/30/60; the status filter finds it).

**Steps:**
  1. Use page.clock to set the time to 2026-01-03T00:10Z (15 min after 23:55 is the boundary; check just before and after), 00:25, 00:55 and 01:55 (via fastForward, FleetStore ticks every minute).
    - expect: Pill goes Reporting -> 'No data in 15 min' (yellow) -> 'No data in 30 min' (orange) -> 'No data in 60 min' (red) after each threshold
    - expect: Overview 'Turbines reporting' decreases; status filter finds them; map legend colours follow

#### 5.3. Turbine page status pill follows staleness

**File:** `tests/staleness/staleness.spec.ts`

**Status:** Automated (and the overview reporting count drops).

**Steps:**
  1. Open TURB001 page with clock advanced 40 minutes.
    - expect: status pill 'No data in 30 min'

#### 5.4. Turbine with no readings

**File:** `tests/turbines/turbine-table.spec.ts`

**Status:** Partly: the 'No readings yet' status filter is checked against the response (no such turbine in the fixture, so CI sees the no-matches state).

**Steps:**
  1. Find a turbine without telemetry (if any).
    - expect: Pill 'No readings yet'; excluded from reporting count

### 6. 6. Alerting history

**Seed:** `tests/seed.spec.ts`

#### 6.1. /alerting redirects to History; tabs navigate

**File:** `tests/alerting/history.spec.ts`, `tests/roles/roles.spec.ts`

**Status:** Automated.

**Steps:**
  1. Click Alerting in the nav.
    - expect: URL /alerting/history; heading 'Alerting'; tabs History and Rules (alerting-tabs)
  2. Click Rules, then History.
    - expect: URLs /alerting/rules and /alerting/history; active tab highlighted

#### 6.2. Default date range is whole UTC days

**File:** `tests/alerting/history.spec.ts`

**Status:** Automated (at SEED_NOW, Jan 3 00:00 UTC, the default is Jan 2–3: from=2026-01-02T00:00Z to=2026-01-04T00:00Z, inputs '1/2/2026' / '1/3/2026'; the earlier '1/1–1/2' note was wrong).

**Steps:**
  1. Open /alerting/history.
    - expect: history-from '1/1/2026', history-to '1/2/2026' under the fixed clock (verified)
    - expect: history-count text '<n> flagged readings on <m> turbines' (singular wording for 1)

#### 6.3. Empty state

**File:** `tests/alerting/history.spec.ts`

**Status:** Automated (count text derived from the response; with the fixture it is the empty state).

**Steps:**
  1. Open history in the current DB (no readings were flagged) or pick a range with no alerts.
    - expect: '0 flagged readings on 0 turbines' and history-empty 'No alerts in this range.'; paginator '0 of 0' (verified)

#### 6.4. [SEED] [DATA] Flagged readings grouped by turbine

**File:** `tests/data/live.spec.ts`, `tests/alerting/history.spec.ts`

**Status:** Automated ([DATA]: a real reading flagged by a rule, its Warning pill and chip; read-only: served readings for 30 turbines with two levels, expand/collapse, two rows open, chips after the @defer).

**Steps:**
  1. Setup: as owner, create two rules (e.g. Gearbox above 120 °C error, Blade pitch above 30° info), then upload a CSV with a TURB002 reading at 2026-01-02T12:02:00Z (gearbox 126.5) and one at 2026-01-01T18:12:00Z (pitch 44). Cleanup: delete the readings is not possible through the API, so disable (PATCH enabled false) the rules afterwards. Open history for 1/1/2026–1/2/2026.
    - expect: One summary row per turbine with Turbine, Farm, Latest (UTC), Alerts pills 'Error: n' / 'Warning: n' worst level first
    - expect: Counts equal sum of rules triggered across that turbine's readings
  2. Click history-expand on a row.
    - expect: Detail row shows readings (history-reading) each with level-coloured alert-chip items; toggling again collapses; multiple rows can be expanded

#### 6.5. Change date range with picker

**File:** `tests/alerting/history.spec.ts`

**Status:** Automated (real calendar overlay: Previous month, Dec 30 → Dec 31; Jan 4 disabled. Only a complete range is queried: picking the start day sends nothing (the end input is cleared, no `history-range-error`, the count keeps the last results), picking the end day sends exactly one request with both new bounds; re-picking the range already shown sends nothing; typed days still load as soon as the range is complete).

**Steps:**
  1. Open the calendar toggle, choose a start day.
    - expect: Start input shows it, end input empty, the calendar stays open; no request and no range error
  2. Choose the end day.
    - expect: The calendar closes; inputs show the days; exactly one request since the calendar opened, with whole-UTC-day from/to (end day exclusive +1)
  3. Re-pick the days already shown (Jan 2 → Jan 3).
    - expect: No request
  4. Type a start day, then an end day.
    - expect: One request per complete range (the typed start with the shown end, then both)

#### 6.6. Range validation errors

**File:** `tests/alerting/history.spec.ts`

**Status:** Automated (typed end before start, 32 days, then exactly 31 days requested).

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

**File:** `tests/alerting/history.spec.ts`

**Status:** Automated.

**Steps:**
  1. Route GET /api/alerts to 500, open history.
    - expect: history-error 'The alerts could not be loaded.' with Retry button
  2. Unroute and click history-retry.
    - expect: Table loads; error disappears

#### 6.8. [SEED] History pagination (25 turbines per page)

**File:** `tests/alerting/history.spec.ts`

**Status:** Automated.

**Steps:**
  1. Neither seed has more than 25 turbines (fixture 2, demo 25), and only seeds create turbines, so mock GET /api/alerts with page.route to return readings for 30 turbines, then view history.
    - expect: history-paginator shows 1 – 25 of N; Next shows the remainder; expansion state does not leak across pages

### 7. 7. Alert rules (serial, mutating)

**Seed:** `tests/seed.spec.ts`

#### 7.1. Rules list renders

**File:** `tests/roles/roles.spec.ts`, `tests/data/rules.spec.ts`

**Status:** Automated.

**Steps:**
  1. Open /alerting/rules as admin.
    - expect: Heading '<n> rules'; table columns Metric, Condition, Threshold, Level, Enabled, Actions; with the fixture there are no rules ('0 rules' and the empty state); after creating one, a row like 'Power output (kW) | below | 100 kW | Warning'; edit/delete buttons labelled 'Edit rule: ...'; paginator '1 – n of n'
    - expect: Add rule button (add-rule) visible

#### 7.2. [DATA] Create a rule

**File:** `tests/data/rules.spec.ts`

**Status:** Automated (Wind speed above 45 m/s, Info; deleted afterwards).

**Steps:**
  1. Click Add rule.
    - expect: Dialog 'Add alert rule' with Metric, Condition, Threshold (unit suffix follows metric), Level, Cancel and 'Add rule' buttons
  2. Select Wind speed, Condition above, Threshold 30, Level Info, click Add rule.
    - expect: Dialog closes; rules-notice confirms; table lists 'Wind speed above 30 m/s Info'; count increments
  3. Cleanup: delete that rule.
    - expect: Rule removed, count restored

#### 7.3. Create validation: empty and invalid threshold

**File:** `tests/alerting/rules.spec.ts`

**Status:** Automated (empty threshold 'Enter a threshold value.', unit follows the metric, Cancel sends nothing; API 400 messages for odd values are not automated).

**Steps:**
  1. Open Add rule, clear threshold, press Add rule.
    - expect: rule-value-error shown; dialog stays open; no request
  2. Enter negative / out-of-range / 'e' values.
    - expect: Error or API 400 message surfaced in rule-error (class-validator messages joined by '. ')
  3. Press Cancel.
    - expect: Dialog closes, nothing created

#### 7.4. [DATA] Duplicate rule gives 409 message

**File:** `tests/data/rules.spec.ts`

**Status:** Automated.

**Steps:**
  1. Add rule: Gearbox temperature above 99 Warning twice (second attempt).
    - expect: rule-error 'A Warning rule for “Gearbox temperature above” already exists. Edit that rule, or choose another condition or level.'; dialog remains open
  2. Cleanup: cancel and delete the created rule.
    - expect: Only the original rules remain

#### 7.5. [DATA] Edit a rule

**File:** `tests/data/rules.spec.ts`

**Status:** Automated.

**Steps:**
  1. Create temp rule 'Rotor speed above 25 Info', click its Edit button.
    - expect: Dialog 'Edit alert rule' prefilled; button 'Save changes'
  2. Change threshold to 26 and Level to Warning, save.
    - expect: Row updates to 26 / Warning
  3. Cleanup: delete the rule.
    - expect: Removed

#### 7.6. [DATA] Edit collides with an existing rule

**File:** —

**Status:** Not automated (same 409 path as 7.4, through PATCH).

**Steps:**
  1. Create two rules same metric/condition with different levels; edit one to the other's level.
    - expect: Duplicate message appears in dialog; nothing saved
  2. Cleanup: delete both.
    - expect: Restored

#### 7.7. [DATA] Disable and re-enable a rule

**File:** `tests/data/rules.spec.ts`, `tests/data/live.spec.ts`

**Status:** Automated. The row's `rule-enabled-toggle` (a `mat-slide-toggle`; its `button[role=switch]` is named 'Disable <rule>' / 'Enable <rule>' and carries `aria-checked`) for owners and admins; the editor's 'Enabled' switch (`rule-enabled`).

**Steps:**
  1. As owner, switch a temp rule (Wind speed above 46 m/s, Warning) off in its row.
    - expect: rules-notice 'Rule disabled: <rule>.'; row `data-enabled="false"`, switch `aria-checked="false"` named 'Enable <rule>', `rule-disabled` pill 'Disabled'; the API has `enabled: false`; the same after a reload
  2. Switch it on again.
    - expect: 'Rule enabled: <rule>.'; no pill; `enabled: true`, also after a reload
  3. Route the PATCH to a held 500, switch it off.
    - expect: while held: `data-pending`, switch off and disabled; then `rules-toggle-error` (role=alert) 'Could not disable “<rule>”. Internal server error.', the switch back on and enabled, the API unchanged
  4. Add rule: the Enabled switch is on by default; switched off, the rule is created disabled. Edit: the switch shows the rule's state; off → saved disabled, on → saved enabled.
    - expect: the API's `enabled` follows; the row shows the state
  5. As viewer: `rule-enabled-state` 'Enabled' (or the 'Disabled' pill), no switch. A viewer's open page follows an owner's switch in another browser without reload.
  6. Ingestion: with 'Gearbox temperature below 5 °C → Info' switched off, upload a 2 °C reading for a per-run turbine.
    - expect: the turbine page's readings table shows '–' for it; no History row for the turbine
  7. Switch it on, upload the next 2 °C reading.
    - expect: that reading has 'Info: 1' on the turbine page (the earlier one stays '–'); History lists the turbine with 'Info: 1' and one reading with the chip 'Info: Gearbox temperature 2 °C < 5'
  8. Cleanup: the wind rules are deleted; the gearbox rule has flagged a reading, so it is disabled (the next run re-enables it).

#### 7.8. [DATA] Delete an unused rule

**File:** `tests/data/rules.spec.ts`

**Status:** Automated.

**Steps:**
  1. Create temp rule; click Delete rule on it.
    - expect: Confirm dialog naming the rule; confirm-delete button
  2. Cancel.
    - expect: Rule remains
  3. Delete again and confirm.
    - expect: Rule gone; count decrements

#### 7.9. [DATA][SEED] Delete a rule triggered by readings returns 409

**File:** `tests/data/live.spec.ts`

**Status:** Automated (`tests/data/live.spec.ts`: after the 409 the title is 'This rule can’t be deleted', `delete-triggered` (role=alert) explains it in words (never the API's text with the internal id), `confirm-delete` is gone and the buttons are Cancel and 'Disable rule' (focused); Disable rule closes the dialog, 'Rule disabled: Rotor speed above 50 rpm.', the row is switched off, shows the 'Disabled' pill and is muted (`--muted` text). `tests/data/rules.spec.ts`: an already-disabled triggered rule says 'It’s already disabled, so it isn’t evaluated.' and offers only Close).

**Steps:**
  1. Precondition: a rule that readings have triggered (e.g. Gearbox above 55 C after TURB002 anomalies ingested). Click Delete and confirm.
    - expect: Title 'This rule can’t be deleted'; delete-triggered 'This rule has flagged readings, so it can’t be deleted — they keep their history. Disable it instead to stop it from being evaluated.'; buttons Cancel and Disable rule; no confirm-delete
  2. Click Disable rule.
    - expect: Dialog closes; rules-notice 'Rule disabled: <rule>.'; the rule is kept, switched off, with the Disabled pill, muted
  3. Delete a triggered rule that is already disabled.
    - expect: delete-triggered ends 'It’s already disabled, so it isn’t evaluated.'; only Close (focused); Close keeps the rule

#### 7.10. Rules API failure

**File:** `tests/alerting/rules.spec.ts`

**Status:** Automated.

**Steps:**
  1. Route GET /api/alert-configs to 500 and open the Rules page.
    - expect: rules-load-error shown
  2. Route POST to abort and try Add rule.
    - expect: rule-error 'Could not reach the API. Check your connection and try again.'; Save button re-enabled

#### 7.11. Empty rules list and rules pagination

**File:** `tests/roles/roles.spec.ts`

**Status:** Partly: the empty state with the fixture (no rules); rules paging (30 rules) is not automated.

**Steps:**
  1. Mock GET /api/alert-configs to [] and then to 30 rules.
    - expect: testid no-rules message; with 30 rules rules-paginator shows 1 – 25 of 30

### 8. 8. Reporting

**Seed:** `tests/seed.spec.ts`

#### 8.1. Report form renders

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated.

**Steps:**
  1. Open /reporting as admin (or owner).
    - expect: Heading 'Reporting'; report-scope with placeholder 'e.g. Prairie Ridge or TURB001'; report-range; Run report enabled; Download CSV disabled; no report yet

#### 8.2. Required-field validation

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated.

**Steps:**
  1. Click Run report with empty form.
    - expect: 'Choose a farm or turbine.' and 'Choose the start and end dates.' errors; no API request
  2. Type free text 'abc' in scope and valid dates, Run.
    - expect: 'Choose a farm or turbine from the list.'
  3. Choose TURB001, open the calendar and pick a start day (automated).
    - expect: The end input is cleared, but neither 'Choose the start and end dates.' nor a range error shows and the end input isn't marked invalid while the calendar is open; no request
  4. Pick the end day, Run report (automated).
    - expect: No request before Run; then exactly one with from = the start day and to = the day after the end day
  5. With both days typed, open the calendar, pick only a start day and press Escape (automated).
    - expect: 'Choose the start and end dates.' shows once the calendar is closed; Run sends nothing

#### 8.3. Autocomplete groups Farms and Turbines

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated (options are 'Prairie Ridge (FARM01)' and 'TURB001 · Prairie Ridge', so 'Prairie' also lists that farm's turbines; 'farm01' lists only the farm).

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

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated (counts from the response; charts with SVG; first row Jan 1, 00:00).

**Steps:**
  1. Pick TURB001, dates 1/1/2026 - 1/2/2026, Run report.
    - expect: 'Loading report…' then status 'TURB001 · <name>, Jan 1, 2026 – Jan 2, 2026 (UTC)'
    - expect: Summary tiles incl. Readings 576 (2 days x 288)
    - expect: One line chart per metric and an alerts chart
    - expect: report-table rows, report-paginator; row alerts pills (report-row-alerts)

#### 8.5. [SEED] Farm report aggregates

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated.

**Steps:**
  1. Pick farm Prairie Ridge, range Jan 1-2, Run.
    - expect: Status shows 'Prairie Ridge (FARM01)'; power chart is summed, others averaged; table includes all farm turbines' readings

#### 8.6. Range rules (31 day max, order)

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated (32 days refused without a request; exactly 31 days is covered on History, 6.6).

**Steps:**
  1. Choose 32 days.
    - expect: report-range-error 'Choose at most 31 days.'; no request
  2. Choose exactly 31 days ending 1/3/2026 or earlier.
    - expect: Request is sent
  3. Choose end before start / date after today.
    - expect: Error or picker rejects

#### 8.7. Empty report

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated.

**Steps:**
  1. Run a report for a farm/turbine and dates with no readings (e.g. 12/1/2025 - 12/2/2025).
    - expect: report-empty 'No readings in this range.'; Download CSV disabled; no charts

#### 8.8. [SEED] CSV download

**File:** `tests/reporting/reporting.spec.ts`, `tests/data/live.spec.ts`

**Status:** Automated (file name, header, CRLF, one row per reading, the first row's fields; [DATA]: the alerts column 'warn:rotor_rpm above 50').

**Steps:**
  1. Run turbine report, click Download CSV with waitForEvent('download').
    - expect: File named after scope and days; header = telemetry.csv columns + alerts; one row per reading; anomalous rows (13:40 0 kW) included

#### 8.9. Report error and retry

**File:** `tests/reporting/reporting.spec.ts`

**Status:** Automated.

**Steps:**
  1. Route /api/reports/telemetry to 500, run report.
    - expect: report-error 'The report could not be loaded.' with Retry
  2. Unroute, click report-retry.
    - expect: Report loads

#### 8.10. Report table pagination

**File:** —

**Status:** Not automated (the shared paginator is covered on Turbines and History).

**Steps:**
  1. After a 2-day report, use report-paginator Next and change page size.
    - expect: Row counts and range label update; chart unaffected

### 9. 9. Live updates (SSE)

**Seed:** `tests/seed.spec.ts`

#### 9.1. Live status indicator

**File:** `tests/live/status.spec.ts`

**Status:** Automated (held stream: 'Connecting…' → 'Live', access_token in the URL; 503 → 'Reconnecting…', new EventSources, recovery → 'Live' and one more GET /api/farms (resync)).

**Steps:**
  1. Open /farms.
    - expect: live-status first 'Connecting…' then 'Live'
  2. Block /api/events (route abort) and reload.
    - expect: Status shows a reconnecting/disconnected state (verify exact text) and recovers when unblocked

#### 9.2. [DATA] CSV upload updates tables without reload

**File:** `tests/data/live.spec.ts`

**Status:** Automated (a per-run turbine; the Turbines row and the turbine page update without reload).

**Steps:**
  1. Open /turbines and note TURB001's Last reading. In the test, POST a one-row telemetry.csv (multipart field 'file', new timestamp, e.g. 2026-01-03T00:05:00Z) to http://localhost:8081/ingest/telemetry using request context.
    - expect: Upload returns success (1 inserted)
    - expect: Without reload, the TURB001 row's Last reading and values update; farm tile 'Data as of' updates
  2. Open TURB001 page, upload another reading.
    - expect: Latest reading label, charts and readings table gain the new row
  3. Cleanup: the reading cannot be deleted via UI; run on a disposable DB or use a distinct timestamp and document it.
    - expect: Serial execution only

#### 9.3. [DATA] Uploaded anomaly flags alerts live

**File:** `tests/data/live.spec.ts`

**Status:** Automated (rule Rotor speed above 50 rpm → Warning; pill, tooltip, alerts chart legend, History chip, report CSV).

**Steps:**
  1. With rules Gearbox above 55 C present, upload a reading with gearbox 126.5 for TURB002.
    - expect: Turbine page readings table shows an Alerts pill 'Warning: 1' without reload; History (re-run range) shows TURB002 with the chip

#### 9.4. [DATA] Stale turbine recovers on new reading

**File:** `tests/data/live.spec.ts`

**Status:** Automated (the turbine's latest is 65 min old at the fixed clock: 'No data in 60 min' → 'Reporting' on upload).

**Steps:**
  1. Advance the clock 40 min so TURB001 reads 'No data in 30 min', then upload a reading with a current timestamp.
    - expect: Pill returns to 'Reporting' without reload

#### 9.5. [DATA] Rule change event refreshes rules

**File:** `tests/data/rules.spec.ts`

**Status:** Automated (a viewer's open page follows an owner's PATCH through the API, and an owner's row switch in another browser context: 'Disabled' pill and back to 'Enabled').

**Steps:**
  1. Open /alerting/rules in page A, create a rule via API or page B, cleanup after.
    - expect: Page A updates the list without reload (alert-config.changed event); verify behaviour

#### 9.6. Invalid CSV upload is rejected and UI unchanged

**File:** `tests/data/live.spec.ts`

**Status:** Automated (API-level: 400 with line 3; the valid row is not stored either).

**Steps:**
  1. POST a CSV with an invalid row to the ingestion endpoint.
    - expect: 400 with line-based errors; nothing stored; open pages show no change

### 10. 10. Navigation and layout

**Seed:** `tests/seed.spec.ts`

#### 10.1. Desktop side nav

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated (nav links, titles, aria-current; the skip link is not).

**Steps:**
  1. Viewport 1280x800, open /farms.
    - expect: Sidebar (testid sidebar) is a left column with brand, live-status, main-nav links Farms, Turbines, Alerting, Reporting, user block and Sign out; nav-toggle hidden
    - expect: Skip to content link focuses main content on keyboard Tab/Enter
  2. Click each nav link.
    - expect: URLs /turbines, /alerting(/history), /reporting, /farms; active link highlighted (aria-current)

#### 10.2. Nav highlights parent section on deep routes

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated.

**Steps:**
  1. Open a turbine page /farms/FARM01/turbines/TURB001 and /alerting/rules.
    - expect: Farms resp. Alerting remains active

#### 10.3. Phone top bar with menu toggle

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated.

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

**File:** `tests/roles/roles.spec.ts`

**Status:** Partly: no page-level horizontal overflow on /turbines at 375 px; the turbine page and History on a phone are not automated.

**Steps:**
  1. At 375px open /turbines, a turbine page and /alerting/history.
    - expect: No page-level horizontal overflow; tables scroll within their frame; paginators reachable

#### 10.5. Unknown URLs redirect to /farms

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated.

**Steps:**
  1. Signed in, open /nope/xyz and /.
    - expect: Both end at /farms (verified)

#### 10.6. Browser back/forward and deep links

**File:** `tests/roles/roles.spec.ts`

**Status:** Automated (farm → turbine, back twice, forward; same document).

**Steps:**
  1. Navigate farms -> farm -> turbine, use back twice, forward once.
    - expect: Each URL and view restored without full reload; deep-link to turbine URL with a fresh load works after sign-in

#### 10.7. Page titles

**File:** `tests/roles/roles.spec.ts`, `tests/farms/turbine-page.spec.ts`

**Status:** Automated.

**Steps:**
  1. Visit each page.
    - expect: Titles: 'Fleet overview · Nextera', 'Turbines · Nextera', 'Alert history · Nextera', 'Alert rules · Nextera', 'Farm · Nextera', 'Turbine · Nextera' (verified for several)

### 11. 11. Unallocated turbines

**Seed:** `tests/seed.spec.ts` (sign-in and clock via `tests/support/session.ts` `signIn(page, role)`)

Readings of turbine ids that aren't in the fleet (`unknown_turbine`) and of turbines reporting another farm than their own (`farm_mismatch`) are held by ingestion (CSV and Pub/Sub) instead of rejected, listed under /unallocated/pending (owner and admin), and imported on assign/keep/move; blocking a (turbine id, reported farm) pair drops its readings until unblocked. The CSV upload answers `held` and `blocked` counts. Ingestion checks timestamps against the real server clock (not in the future, from 2000-01-01) while the browser clock is fixed at SEED_NOW, so pick past timestamps and reason about what the fixed clock shows (Jan 2 23:55 reads as 'Reporting'). The browser runs in the UTC zone (`timezoneId` in playwright.config.ts): under `page.clock` the app's date-fns `UTCDate` formatting falls back to the local zone. Cleanup: unknown ids are unique per run (`E2E-<run>-…`), entries are removed through the API (block, then unblock) in afterAll; there is no turbine/telemetry delete API, so each run leaves two turbines (`E2E-<run>-NEW` on FARM01 and `E2E-<run>-MOV` on FARM03, 2 readings each on Jan 2 23:50–23:55) and one TURB001 reading at a unique 2020 timestamp (outside every window the app shows).

#### 11.1. Access by role

**File:** `tests/unallocated/access.spec.ts`

**Steps:**
  1. Sign in as viewer.
    - expect: main nav has Farms but no 'Unallocated' link
    - expect: /unallocated and /unallocated/blocked redirect to /farms
  2. GET /api/unallocated-turbines with a viewer token.
    - expect: 404 (the RolesGuard convention)
  3. Sign in as owner, click 'Unallocated' in the nav.
    - expect: /unallocated/pending, title 'Unallocated turbines · Nextera', heading 'Unallocated turbines', Pending tab aria-current=page
    - expect: Blocked tab → /unallocated/blocked, title 'Blocked turbines · Nextera'

#### 11.2. [DATA] Held unknown turbine appears live and expands to its readings

**File:** `tests/data/unallocated.spec.ts`

**Steps:**
  1. Owner on /unallocated/pending, list loaded and live-status 'Live'. POST a 3-row CSV for `E2E-<run>-LIVE` / FARM01 (Jan 2 23:45, 23:50, 23:55) to ingestion :8081.
    - expect: upload `{ rows: 3, inserted: 0, held: 3, blocked: 0 }`
    - expect: without reload (SSE `unallocated-turbine.changed`), the row appears: 'Unknown turbine', 'Prairie Ridge (FARM01)', current farm '–', held 3, latest '1,520 kW · 8.2 m/s · 71.5 °C', staleness 'Reporting', 'Assign … to farm…' button
  2. Click 'Show held readings for <id>'.
    - expect: aria-expanded true; '3 held readings, newest first.'; 3 rows newest first (Jan 2, 23:55 … Jan 2, 23:45)

#### 11.3. [DATA] Assign an unknown turbine to FARM01

**File:** `tests/data/unallocated.spec.ts`

**Steps:**
  1. Upload 2 readings for `E2E-<run>-NEW` / FARM01, open Pending, click 'Assign <id> to farm…'.
    - expect: dialog 'Assign <id> to a farm' with Farm preselected 'Prairie Ridge (FARM01)' (the reported farm exists)
  2. Click 'Assign'.
    - expect: dialog closes; notice '<id> assigned to Prairie Ridge (FARM01): 2 readings imported.'; row gone
  3. Without reload, nav → Turbines, filter by the id.
    - expect: row on Prairie Ridge, 'Reporting', last reading Jan 2, 23:55, not commissioned
  4. Open the turbine, then its farm from the breadcrumb.
    - expect: /farms/FARM01/turbines/<id>, 'Not commissioned', readings table rows Jan 2 23:55 (1,640.0) and 23:50 (1,610.0)
    - expect: /farms/FARM01 lists the turbine

#### 11.4. [DATA] Farm mismatch: Keep in the turbine's own farm

**File:** `tests/data/unallocated.spec.ts`

**Steps:**
  1. Upload one TURB001 reading reporting FARM02 at a unique 2020 timestamp; open Pending.
    - expect: upload held 1; row 'Farm mismatch', reported 'High Plains (FARM02)', current 'Prairie Ridge (FARM01)', 'Move TURB001 to FARM02…' enabled
  2. Click 'Keep TURB001 in FARM01'.
    - expect: notice 'TURB001 kept in Prairie Ridge (FARM01): 1 reading imported.'; row gone
    - expect: GET /api/turbines/TURB001/telemetry for that second returns the reading with farmId FARM01

#### 11.5. [DATA] Block drops readings; Unblock removes the entry

**File:** `tests/data/unallocated.spec.ts`

**Steps:**
  1. Upload one reading for `E2E-<run>-BLK` / FARM05; open Pending; click 'Block <id> from FARM05…'.
    - expect: dialog 'Block <id> from FARM05?' explaining readings will be dropped until unblocked
  2. Click 'Block'.
    - expect: notice 'Readings for <id> from FARM05 are now blocked.'; row gone
  3. Upload another reading for the same pair.
    - expect: `{ rows: 1, inserted: 0, held: 0, blocked: 1 }`
  4. Blocked tab.
    - expect: row 'Blue Sky (FARM05)', 'Unknown turbine', blocked by 'owner@nextera.local', a blocked time
  5. Click 'Unblock <id> from FARM05'.
    - expect: notice '<id> from FARM05 unblocked: its next reading will show under Pending.'; row gone; the API lists the id under neither status

#### 11.6. [DATA] Farm mismatch: Move to the reported farm with its history

**File:** `tests/data/unallocated.spec.ts`

**Steps:**
  1. Setup through the API: upload `E2E-<run>-MOV` / FARM01 (Jan 2 23:50) and assign it to FARM01; then upload it reporting FARM03 (Jan 2 23:55). Open Pending.
    - expect: row 'Farm mismatch', current 'Prairie Ridge (FARM01)'
  2. Click 'Move <id> to FARM03…'.
    - expect: dialog 'Move <id> to FARM03?': '<id> and all its readings will move to Red Canyon (FARM03)…'
  3. Click 'Move turbine'.
    - expect: notice '<id> moved to Red Canyon (FARM03): 1 reading imported.'; row gone
    - expect: GET telemetry: both readings (23:55 and the earlier 23:50) now have farmId FARM03
    - expect: without reload, Turbines (filtered) shows it on Red Canyon, last reading Jan 2, 23:55

#### 11.7. Not yet automated (covered by the Angular unit specs, `unallocated-pages.spec.ts`)

  - Move disabled with a reason when the reported farm doesn't exist; Assign with coordinates, and picking a farm from the autocomplete when the reported farm doesn't exist; a 409/404 when the entry was resolved in another browser; load errors and Retry.

### 12. 12. Settings: time zone

**Seed:** none (own setup in `tests/settings/time-zone.spec.ts`: `fixBrowserDate(page, SEED_NOW)` from `tests/support/clock.ts`, then `logIn(page, role)` from `tests/support/session.ts`)

/settings (every role) chooses how times are shown: UTC (the default) or the browser's zone, saved in this browser's localStorage per user (`nextera.timeZone.<email>` = `utc` | `local`). The spec's context runs in America/Chicago (`test.use({ timezoneId })`; the config pins UTC for everything else), so SEED_NOW (2026-01-03T00:00Z) is Jan 2, 18:00 CST (UTC−6). Read-only: localStorage isn't data, and each test has its own browser context.

**Clock:** not `page.clock`. Its fake `Date` returns plain Dates from `new`, which breaks the app's Date subclasses (date-fns' `UTCDate` in UTC mode, `@date-fns/tz`'s `TZDate` in Local mode): in a Chicago browser UTC mode then shows Chicago times labelled UTC ("Jan 2, 18:00 UTC" for SEED_NOW), and Local mode is right only because the browser's zone is the chosen one. `fixBrowserDate` installs a Proxy of the native `Date` as an init script (fixed `new Date()`/`Date.now()`, subclasses intact, timers running, survives reloads).

**Live stream:** `page.route('**/api/events**', route => route.abort())`, so no reading arrives mid-test (demo feed, other tests' uploads) and no resync reloads the fleet. The latest reading's expected text is derived from the GET /api/farms response the page rendered, formatted with Node's Intl as an independent oracle; with the db:seed fixture alone it is TURB001's 2026-01-02T23:55Z reading: 'Jan 2, 23:55' (UTC) / 'Jan 2, 17:55 CST' (Local).

#### 12.1. UTC everywhere by default

**File:** `tests/settings/time-zone.spec.ts`

**Steps:**
  1. Admin opens Settings from the nav.
    - expect: title 'Settings · Nextera'; radio 'UTC' aria-checked true, 'Local (America/Chicago, UTC−6)' false; 'Now: Jan 3, 00:00 UTC'; 'Saved in this browser.'
  2. Turbines, filtered to TURB001.
    - expect: header 'Last reading (UTC)'; the row shows the latest reading in UTC ('Jan 2, 23:55' on the fixture)
  3. Open TURB001.
    - expect: 'Ending now (00:00 UTC)'; status 'Latest reading Jan 2, 23:55 UTC' (fixture)
  4. Alerting (→ History).
    - expect: GET /api/alerts from=2026-01-02T00:00:00.000Z to=2026-01-04T00:00:00.000Z; label 'Dates (UTC)'

#### 12.2. Local shows Chicago time, 6 hours earlier, with the zone name

**File:** `tests/settings/time-zone.spec.ts`

**Steps:**
  1. Admin chooses Local on Settings.
    - expect: Local aria-checked true; 'Now: Jan 2, 18:00 CST'
  2. Without reload: Turbines filtered to TURB001.
    - expect: header 'Last reading (local)'; row 'Jan 2, 17:55' (fixture)
  3. Open TURB001.
    - expect: 'Ending now (18:00 CST)'; status 'Latest reading Jan 2, 17:55 CST' (fixture)

#### 12.3. History's default days are local days

**File:** `tests/settings/time-zone.spec.ts`

**Steps:**
  1. Admin chooses Local, then opens Alerting.
    - expect: GET /api/alerts from=2026-01-01T06:00:00.000Z to=2026-01-03T06:00:00.000Z (yesterday and today, Jan 1–2, from 00:00 CST)
    - expect: label 'Dates (local)'; inputs '1/1/2026' – '1/2/2026'

#### 12.4. Reporting runs whole local days

**File:** `tests/settings/time-zone.spec.ts`

**Steps:**
  1. Owner chooses Local, opens Reporting, picks TURB001 from the autocomplete, types 1/1/2026 – 1/2/2026, Run report.
    - expect: label 'Dates (local)'; GET /api/reports/telemetry from=2026-01-01T06:00:00.000Z to=2026-01-03T06:00:00.000Z
    - expect: status 'TURB001 · Prairie Ridge, Jan 1, 2026 – Jan 2, 2026 (local)'; table header 'Measured (local)'; first row 'Jan 1, 00:00' (the fixture's 2026-01-01T06:00Z reading)

#### 12.5. The setting survives a reload, is per user, and switches back

**File:** `tests/settings/time-zone.spec.ts`

**Steps:**
  1. Admin chooses Local.
    - expect: localStorage `nextera.timeZone.admin@nextera.local` = 'local'
  2. Reload.
    - expect: Local still checked, 'Now: Jan 2, 18:00 CST'; Turbines row in Chicago time
  3. Sign out, sign in as viewer (same browser).
    - expect: 'Last reading (UTC)', row in UTC; Settings shows UTC checked
  4. Sign out, sign in as admin again.
    - expect: 'Last reading (local)'
  5. Choose UTC on Settings.
    - expect: 'Now: Jan 3, 00:00 UTC'; Turbines header 'Last reading (UTC)', row in UTC

#### 12.6. Unallocated times in the chosen zone, and what is still not automated

**File:** `tests/data/unallocated-time-zone.spec.ts` ([DATA], browser in America/Chicago, `fixBrowserDate`)

**Status:** Automated: a held entry per run; under Local then UTC, Pending's 'Seen (local|UTC)' header, `last-seen`/`first-seen` (server times from the API entry, formatted with Node's Intl) and the held readings ('Jan 2, 17:55' for 23:55Z); after a block (API), Blocked's 'Blocked (local)' and `blocked-at` in Chicago time.

Still not automated in the browser (covered by the Angular unit specs):
  - Turbine-page chart ticks/candles/tooltips in local time (`scales.spec.ts`, `line-chart.spec.ts`, `chart-tooltips.spec.ts`): SVG text, best checked visually.
  - DST days (23/25 h local days, the 30-day limit across a fall-back change) and a +5:30 zone (`days.spec.ts`, `scales.spec.ts`); the fixture's January has no DST change.
  - Storage errors and unknown stored values (`time-zone.spec.ts`).
  - A zone change while a page stays open: not reachable through the UI (Settings is a separate route; no cross-tab sync).

### 13. 13. Weather (Open-Meteo: the farm Overview and its Weather history tab)

**Seed:** none (own setup in `tests/weather/weather.spec.ts`: `signIn(page, 'admin')` at SEED_NOW in a UTC browser; the Chicago test uses `fixBrowserDate` + `logIn` like section 12)

The farm Overview (`FarmWeather`) and its Weather history tab (`FarmWeatherHistoryPage`, /farms/:farmId/weather, 13.8–13.13) are the only places the web app shows weather. The Overview asks `GET /api/farms/:id/weather` twice: `interval=30min` for the last 24 h (latest tiles, no `timeZone`) and `interval=daily&timeZone=<zone shown>` for the last 7 days ending today. The turbine page shows no weather; the API's `GET /api/turbines/:id/weather` still exists but the web app no longer calls it. The db:seed fixture has no weather (the sync only fetches recent days), so populated views are `page.route` mocks in the API's shape (`tests/support/weather.ts`: bodies built from each request's own from/to/timeZone, values in 0.5 steps so the one-decimal UI text is exact). One farm test uses the real API. Read-only.

**Isolation:** the live stream is aborted (as in section 12). The turbine-page guard (13.1) bounds the turbine's history and stats requests at SEED_NOW (`boundTelemetryAt`, `tests/support/telemetry.ts`, adds `to`) so a DB that also holds later readings (db:seed:demo, the demo feed) still draws the fixture's Jan 2; a no-op on the db:seed fixture alone (CI).

#### 13.1. Turbine page: no weather (guard)

**File:** `tests/weather/weather.spec.ts`

**Steps:**
  1. Admin opens /farms/FARM01/turbines/TURB001 (24 h window, Jan 2) and waits for its telemetry and stats responses and the wind chart.
    - expect: no `weather` or `weather-heading` testid, no `overlay-legend`
    - expect: no request to any `…/weather` path (farm or turbine)

#### 13.2. (removed: the turbine page's weather 500 / Retry; the turbine page has no weather)

#### 13.3. (removed: the turbine page's real-API weather; the farm page's is 13.6)

#### 13.4. Farm page: latest tiles and 7 daily rows, today partial (mocked)

**Steps:**
  1. Admin opens /farms/FARM01.
    - expect: 30min request 2026-01-02T00:00Z – 2026-01-03T00:30Z, no timeZone; daily request 2025-12-28T00:00Z – 2026-01-04T00:00Z, timeZone=UTC
    - expect: 'Latest 30 minutes from Jan 3, 00:00 UTC' (the newest bucket that has started); tiles wind 80 m, gusts, temperature, precipitation from that bucket; 'Today min / max' '-3.0 / 6.0 °C'
    - expect: header 'Day (UTC)'; 7 `weather-day` rows, data-date 2025-12-28 … 2026-01-03; first row 'Sun, Dec 28', 6.0 / 10.0 / -6.0 / 3.0 / 1.5, '48 / 48' not partial; last row 'Sat, Jan 3 (today)', '1 / 48' with `data-partial`; exactly one partial cell
    - expect: the farm's Turbines section still there

#### 13.5. Farm page: weather 500 and Retry (mocked)

**Steps:**
  1. Both weather requests answer 500.
    - expect: 'Weather is unavailable right now.' with Retry; no tiles, no daily table; the farm summary and Turbines unaffected
  2. Healthy again, Retry.
    - expect: both requests sent again; 7 daily rows and the wind tile

#### 13.6. Farm page: real API at the fixture date

**Steps:**
  1. Open FARM01 unmocked.
    - expect: both 200, `interval` echoed, `timeZone` 'UTC'
    - expect: `weather-latest-empty` and `weather-daily-empty` 'No weather synced for this period.' (or the tiles/rows if the DB has weather for those days)

#### 13.7. Daily days follow Settings → Local (browser in America/Chicago, mocked)

**Steps:**
  1. Admin opens FARM01 from the farms table (UTC, the default).
    - expect: daily request 2025-12-28T00:00Z – 2026-01-04T00:00Z, timeZone=UTC; header 'Day (UTC)'
  2. Settings → Local, then Farms → Prairie Ridge (no reload).
    - expect: daily request from=2025-12-27T06:00:00.000Z to=2026-01-03T06:00:00.000Z timeZone=America/Chicago (Dec 27 … Jan 2 from 00:00 CST); the 30min request still has no timeZone
    - expect: header 'Day (local)'; 7 rows Dec 27 … Jan 2, last 'Fri, Jan 2 (today)' '37 / 48' partial; 'Latest 30 minutes from Jan 2, 18:00 CST'

#### 13.8. Farm tabs (Overview / Weather history)

**File:** `tests/weather/weather-history.spec.ts` (13.8–13.13; weather mocked with `mockWeather(page, { until: SEED_NOW, missing: ['2026-01-01T12:00Z'] })`: only buckets started by SEED_NOW, one left out)

**Steps:**
  1. Admin opens /farms/FARM01.
    - expect: `farm-tabs` links 'Overview', 'Weather history'; `farm-tab-overview` has `aria-current="page"`, `farm-tab-weather` none; no `weather-history-range`
  2. Click Weather history.
    - expect: URL /farms/FARM01/weather; the weather tab current, Overview not; title 'Prairie Ridge · Weather history · Nextera'; the range shown, no `farm-power`
  3. Click Overview.
    - expect: back on /farms/FARM01, Overview current, `farm-power` visible
  4. Deep link /farms/FARM01/weather.
    - expect: h1 'Prairie Ridge FARM01', the weather tab current; `back-to-farms` → /farms with the farms table
  5. Deep link /farms/NOPE/weather.
    - expect: `farm-not-found` 'Farm NOPE was not found.', no tabs, no weather request
  6. On Overview, click TURB001 in the turbines table.
    - expect: /farms/FARM01/turbines/TURB001, h1 contains TURB001, no `farm-tabs`

#### 13.9. Weather history: default range, eight charts (mocked)

**Steps:**
  1. Deep link /farms/FARM01/weather.
    - expect: label 'Dates (UTC)'; Start '12/28/2025', End '1/3/2026'
    - expect: exactly one request from=2025-12-28T00:00Z to=2026-01-04T00:00Z interval=30min, no timeZone
    - expect: status '288 of 336 half-hours synced' (289 started buckets, one missing)
    - expect: `weather-history-charts` with 8 `app-line-chart`s in order wind-80m, wind-10m, gusts, temperature, precipitation, humidity, pressure, cloud-cover; each with its title and the 00:00 Jan 3 bucket as latest value (e.g. '6.0 m/s', '1,013 hPa'), and SVG output
    - expect: no empty, error, `charts-load-error` or `weather-history-reset-zoom` (not zoomed)

#### 13.10. Weather history: changing the range (mocked)

**Steps:**
  1. Type Start '12/30/2025' and leave the field.
    - expect: exactly one new request 2025-12-30T00:00Z – 2026-01-04T00:00Z; '192 of 240 half-hours synced'
  2. Type End '1/1/2026'.
    - expect: exactly one new request 2025-12-30T00:00Z – 2026-01-02T00:00Z; '143 of 144 half-hours synced'; the wind-80m latest is the 23:30 Jan 1 bucket
  3. (Fresh page) Start '12/1/2025' (34 days with End Jan 3).
    - expect: `weather-history-range-error` 'Choose at most 31 days.' in the status; no request
  4. End '12/31/2025' (exactly 31 days).
    - expect: the error gone; one request 2025-12-01T00:00Z – 2026-01-01T00:00Z (the second in total); '1488 of 1488 half-hours synced'
  5. (Fresh page) Open the calendar (it opens on December, the start's month) and pick Dec 30.
    - expect: Start '12/30/2025', End empty, the calendar open; no `weather-history-range-error`; the status keeps '288 of 336 half-hours synced'; no request
  6. Pick Dec 31.
    - expect: the calendar closes; exactly one new request 2025-12-30T00:00Z – 2026-01-01T00:00Z (two in total); '96 of 96 half-hours synced'

#### 13.11. Weather history: 500 and Retry (mocked)

**Steps:**
  1. The request answers 500.
    - expect: `weather-history-error` 'The weather could not be loaded.'; no charts, no empty state
  2. Healthy again, `weather-history-retry`.
    - expect: one more request with the same query; the error gone; the status and 8 charts

#### 13.12. Weather history: real API at the fixture date

**Steps:**
  1. Deep link unmocked.
    - expect: 200, from=2025-12-28T00:00Z to=2026-01-04T00:00Z, `farmId` FARM01, `interval` 30min
    - expect: status '<n> of 336 half-hours synced' (n = buckets with any value); n = 0: `weather-history-empty` 'No weather synced for these days.' and no charts; otherwise 8 charts

#### 13.13. Weather history: Local days (browser in America/Chicago, mocked)

**Steps:**
  1. `fixBrowserDate` + `logIn`; deep link the tab (UTC).
    - expect: 'Dates (UTC)', request 2025-12-28T00:00Z – 2026-01-04T00:00Z
  2. Settings → Local, deep link the tab again.
    - expect: 'Dates (local)'; Start '12/27/2025', End '1/2/2026'; request from=2025-12-27T06:00:00.000Z to=2026-01-03T06:00:00.000Z interval=30min, no timeZone; '324 of 336 half-hours synced'

#### 13.14. Weather history zoom, and what is still not automated

**File:** `tests/weather/weather-history.spec.ts` (describe 'Weather history zoom (mocked API)')

**Status:** Automated: a plain wheel over a chart scrolls the page and doesn't zoom; Ctrl+wheel zooms every chart to the same x axis (no 'Dec 28' tick), `weather-history-reset-zoom` appears and restores the 7-day ticks; dragging the slider's left handle (found from the rendered SVG) zooms every chart too.

Still not automated in the browser (covered by the Angular unit specs):
  - Missing values ('–'), a zone change reloading only the daily view in place, no refetch on live readings, Retry of only the failed request, and DST days' expected buckets (`weather/farm-weather.spec.ts`, `weather/weather.spec.ts`).
  - Weather history: a zone change while the tab is open (not reachable through the UI, see 12.6), the gap drawn for a missing bucket, the earlier range dimmed while the next loads, the `@defer` loading/error blocks (`weather/farm-weather-history-page.spec.ts`, `charts/chart-group.spec.ts`).
  - Real synced weather in the browser: the fixture's January has none; it would need seeded `farm_weather` rows for Jan 2026 or a clock inside the synced days.
