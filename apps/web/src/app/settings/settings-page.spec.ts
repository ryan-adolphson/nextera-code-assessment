import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonToggleGroupHarness } from '@angular/material/button-toggle/testing';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { CLOCK_STORAGE_PREFIX, TIME_ZONE_STORAGE_PREFIX } from '../core/time-zone';
import { Role } from '../core/auth/roles';
import { TEST_API_BASE_URL, openFleet, storeTimeZone } from '../fleet/testing';

const CLOCK = Date.parse('2026-01-03T00:00:00.000Z'); // Jan 2, 18:00 CST in Chicago

/** /settings through the real routes; the browser zone is pinned to America/Chicago. */
describe('SettingsPage (/settings)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  const q = (id: string) => app.root().querySelector<HTMLElement>(`[data-testid=${id}]`);
  const toggles = async () =>
    (
      await TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
        MatButtonToggleGroupHarness,
      )
    ).getToggles();
  const checked = (id: string) => q(id)!.querySelector('button')!.getAttribute('aria-checked');

  afterEach(() => {
    app.http.verify();
    localStorage.clear();
  });

  it('offers UTC (the default) and the browser zone, with a preview and where it is saved', async () => {
    app = await openFleet('/settings', () => CLOCK);
    expect(TestBed.inject(Title).getTitle()).toBe('Settings · Nextera');
    expect(app.text(app.root().querySelector('h1'))).toBe('Settings');
    const [utc, local] = await toggles();
    expect(await utc.getText()).toBe('UTC');
    expect(await local.getText()).toBe('Local (America/Chicago, UTC−6)');
    expect(await utc.isChecked()).toBe(true);
    expect(checked('time-zone-local')).toBe('false');
    expect(q('time-zone')!.getAttribute('aria-labelledby')).toBe('time-zone-heading');
    expect(app.text(q('time-zone-now'))).toBe('Jan 3, 00:00 UTC');
    expect(app.text(q('time-zone-note'))).toBe('Saved in this browser.');
  });

  it('switches every page to local time at once and saves it for this user', async () => {
    app = await openFleet('/settings', () => CLOCK, undefined, undefined, 'viewer');
    const [, local] = await toggles();
    await local.check();
    await app.stable();

    expect(checked('time-zone-local')).toBe('true');
    expect(app.text(q('time-zone-now'))).toBe('Jan 2, 18:00 CST');
    expect(localStorage.getItem(`${TIME_ZONE_STORAGE_PREFIX}viewer@nextera.local`)).toBe('local');

    // The turbines table follows (shared state, no reload): 23:55 UTC → 17:55 CST.
    q('nav-turbines')!.click();
    await app.stable();
    expect(app.text(q('sort-time'))).toContain('Last reading (local)');
    const row = app.root().querySelector('tr[data-turbine-id=TURB001]')!;
    expect([...row.querySelectorAll('td')].map((td) => app.text(td))).toContain('Jan 2, 17:55');
  });

  it('offers a 24-hour (default) or 12-hour clock that every page follows and that is saved', async () => {
    app = await openFleet('/settings', () => CLOCK, undefined, undefined, 'viewer');
    const group = q('clock-format')!;
    expect(group.getAttribute('aria-labelledby')).toBe('clock-heading');
    expect(app.text(q('clock-24h'))).toBe('24-hour');
    expect(app.text(q('clock-12h'))).toBe('12-hour');
    expect(q('clock-24h')!.querySelector('button')!.getAttribute('aria-checked')).toBe('true');
    expect(app.text(q('time-zone-now'))).toBe('Jan 3, 00:00 UTC');

    q('clock-12h')!.querySelector('button')!.click();
    await app.stable();
    expect(q('clock-12h')!.querySelector('button')!.getAttribute('aria-checked')).toBe('true');
    expect(app.text(q('time-zone-now'))).toBe('Jan 3, 12:00 AM UTC');
    expect(localStorage.getItem(`${CLOCK_STORAGE_PREFIX}viewer@nextera.local`)).toBe('12h');

    // The turbines table follows (shared state, no reload): 23:55 UTC.
    q('nav-turbines')!.click();
    await app.stable();
    const row = app.root().querySelector('tr[data-turbine-id=TURB001]')!;
    expect([...row.querySelectorAll('td')].map((td) => app.text(td))).toContain('Jan 2, 11:55 PM');
  });

  it("restores the user's saved choice on the next visit", async () => {
    app = await openFleet('/settings', () => CLOCK, undefined, undefined, 'owner', {
      timeZone: 'local',
      browserZone: 'Asia/Kolkata',
    });
    const [utc, local] = await toggles();
    expect(await local.getText()).toBe('Local (Asia/Kolkata, UTC+5:30)');
    expect(await local.isChecked()).toBe(true);
    expect(app.text(q('time-zone-now'))).toBe('Jan 3, 05:30 GMT+5:30');

    await utc.check();
    await app.stable();
    expect(app.text(q('time-zone-now'))).toBe('Jan 3, 00:00 UTC');
    expect(localStorage.getItem(`${TIME_ZONE_STORAGE_PREFIX}owner@nextera.local`)).toBe('utc');
  });

  it("applies each user's own setting when users take turns on one browser (no reload)", async () => {
    app = await openFleet('/turbines', () => CLOCK, undefined, undefined, 'viewer', {
      timeZone: 'local',
    });
    const header = () => app.text(q('sort-time'));
    /** Signs the current user out, then `role` in through /login, and opens the turbines table. */
    const switchUser = async (role: Role) => {
      q('sign-out')!.click();
      await settle();
      const input = (id: string, value: string) => {
        const el = q(id) as HTMLInputElement;
        el.value = value;
        el.dispatchEvent(new Event('input'));
      };
      input('login-email', `${role}@nextera.local`);
      input('login-password', 'correct horse battery');
      q('login-submit')!.click();
      TestBed.tick();
      app.http.expectOne(`${TEST_API_BASE_URL}/auth/login`).flush({
        accessToken: `token-${role}`,
        expiresAt: new Date(CLOCK + 24 * 3_600_000).toISOString(),
        user: { email: `${role}@nextera.local`, role },
      });
      await settle();
      await app.harness.navigateByUrl('/turbines');
      await app.stable();
    };
    expect(header()).toBe('Last reading (local)');

    await switchUser('admin'); // never chose: UTC
    expect(header()).toBe('Last reading (UTC)');

    storeTimeZone('admin', 'utc');
    await switchUser('viewer'); // back to the viewer's saved Local
    expect(header()).toBe('Last reading (local)');
  });

  /** Rendered after HTTP answers and navigations (sign-in and sign-out are pending tasks). */
  async function settle() {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    await app.stable();
  }
});
