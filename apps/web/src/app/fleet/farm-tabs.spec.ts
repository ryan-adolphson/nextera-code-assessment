import { TestKey } from '@angular/cdk/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestBed } from '@angular/core/testing';
import { MatTabNavBarHarness } from '@angular/material/tabs/testing';
import { Title } from '@angular/platform-browser';
import { NavigationEnd, Router } from '@angular/router';
import { filter, firstValueFrom } from 'rxjs';
import { Role } from '../core/auth/roles';
import { TEST_API_BASE_URL, openFleet } from './testing';

/**
 * A farm's routed tabs: Overview (/farms/:farmId), History (/farms/:farmId/history) and Weather
 * history (/farms/:farmId/weather), a Material tab nav bar under the farm header with the page in
 * its tab panel. The fake WeatherApi answers at once with no weather; History's daily request goes
 * to HttpTestingController (so that tab is opened with a DOM click: a harness would wait for it).
 */
describe('Farm tabs (/farms/:farmId, /history, /weather)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;

  async function open(url: string, role: Role = 'admin') {
    app = await openFleet(url, () => CLOCK, undefined, undefined, role);
    await app.stable();
  }
  const q = <T extends Element = HTMLElement>(id: string) =>
    app.root().querySelector<T>(`[data-testid=${id}]`);
  const tab = (id: 'overview' | 'history' | 'weather') => q<HTMLAnchorElement>(`farm-tab-${id}`)!;
  const links = () => [...app.root().querySelectorAll<HTMLElement>('[data-testid=farm-tabs] a')];
  /** The selected tab(s), by ARIA (Material's tabs pattern: aria-selected, not aria-current). */
  const current = () =>
    links()
      .filter((a) => a.getAttribute('aria-selected') === 'true')
      .map((a) => app.text(a));
  const url = () => TestBed.inject(Router).url;
  const tabBar = () =>
    TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatTabNavBarHarness.with({ selector: '[data-testid=farm-tabs]' }),
    );
  /** Sends a key to the focused tab link, like a keyboard user. */
  async function press(key: TestKey | string) {
    const bar = await tabBar();
    const focused = document.activeElement;
    for (const link of await bar.getLinks()) {
      const host = await link.host();
      if ((await host.getProperty<string>('id')) === focused?.id) {
        await host.sendKeys(key);
        return;
      }
    }
    throw new Error('No tab link has focus');
  }

  it('shows the three tabs under the farm header on the Overview, with Overview current', async () => {
    await open('/farms/FARM01');
    const nav = q('farm-tabs')!;
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('Farm');
    expect(links().map((a) => [app.text(a), a.getAttribute('href')])).toEqual([
      ['Overview', '/farms/FARM01'],
      ['History', '/farms/FARM01/history'],
      ['Weather history', '/farms/FARM01/weather'],
    ]);
    expect(current()).toEqual(['Overview']);

    // Material tab nav bar (harness): labels and the active link.
    const bar = await tabBar();
    expect(await Promise.all((await bar.getLinks()).map((l) => l.getLabel()))).toEqual([
      'Overview',
      'History',
      'Weather history',
    ]);
    expect(await (await bar.getActiveLink()).getLabel()).toBe('Overview');

    // ARIA tabs pattern ([tabPanel]): tablist > tab (aria-selected, aria-controls) + tabpanel
    // labelled by the selected tab. One tab stop (the selected tab); no aria-current.
    const panel = q('farm-tab-panel')!;
    expect(nav.getAttribute('role')).toBe('tablist');
    expect(links().map((a) => a.getAttribute('role'))).toEqual(['tab', 'tab', 'tab']);
    expect(links().map((a) => a.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(links().map((a) => a.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(links().every((a) => a.getAttribute('aria-controls') === panel.id)).toBe(true);
    expect(links().some((a) => a.hasAttribute('aria-current'))).toBe(false);
    expect(panel.tagName).toBe('MAT-TAB-NAV-PANEL');
    expect(panel.getAttribute('role')).toBe('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('overview').id);
    // Left-aligned tabs (not stretched over the width).
    expect(nav.classList).not.toContain('mat-mdc-tab-nav-bar-stretch-tabs');

    // The header comes first: h1, then the tabs, then the page inside the tab panel.
    const h1 = app.root().querySelector('h1')!;
    expect(app.text(h1)).toBe('Prairie Ridge FARM01');
    expect(h1.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel.contains(q('farm-weather'))).toBe(true);
    expect(panel.contains(q('turbines'))).toBe(true);
    expect(panel.contains(h1)).toBe(false);
    // The side nav's Farms item stays current (it is a link list with aria-current).
    expect(q('nav-farms')!.getAttribute('aria-current')).toBe('page');
  });

  it('switches between the tabs with the links (bookmarkable URLs)', async () => {
    await open('/farms/FARM01');
    const bar = await tabBar();
    await bar.clickLink({ label: 'Weather history' });
    await app.stable();
    expect(url()).toBe('/farms/FARM01/weather');
    expect(current()).toEqual(['Weather history']);
    // Each tab is its own route with its own FarmHeader, so the bar is a new one: look it up again.
    expect(await (await (await tabBar()).getActiveLink()).getLabel()).toBe('Weather history');
    expect(q('weather-history-range')).not.toBeNull();
    expect(q('farm-weather')).toBeNull();
    expect(q('farm-tab-panel')!.getAttribute('aria-labelledby')).toBe(tab('weather').id);
    expect(TestBed.inject(Title).getTitle()).toBe('Prairie Ridge · Weather history · Nextera');

    await (await tabBar()).clickLink({ label: 'Overview' });
    await app.stable();
    expect(url()).toBe('/farms/FARM01');
    expect(current()).toEqual(['Overview']);
    expect(q('farm-weather')).not.toBeNull();
    expect(q('turbines')).not.toBeNull();
    expect(TestBed.inject(Title).getTitle()).toBe('Farm · Nextera');
  });

  it('moves between the tabs with the arrow keys, Home and End, and opens one with Enter or Space', async () => {
    await open('/farms/FARM01');
    tab('overview').focus();

    await press(TestKey.RIGHT_ARROW);
    expect(document.activeElement).toBe(tab('history'));
    // Focus moves the tab stop, not the selection (manual activation: links navigate on Enter).
    expect(url()).toBe('/farms/FARM01');
    expect(current()).toEqual(['Overview']);
    expect(links().map((a) => a.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);

    await press(TestKey.END);
    expect(document.activeElement).toBe(tab('weather'));
    await press(TestKey.RIGHT_ARROW); // wraps
    expect(document.activeElement).toBe(tab('overview'));
    await press(TestKey.LEFT_ARROW); // wraps back
    expect(document.activeElement).toBe(tab('weather'));

    await press(TestKey.ENTER);
    await app.stable();
    expect(url()).toBe('/farms/FARM01/weather');
    expect(current()).toEqual(['Weather history']);

    // The new page's bar: the selected tab is the single tab stop, so Tab lands on it. (Focus is
    // not kept across the navigation: the routes are siblings, so the old bar is destroyed.)
    expect(links().map((a) => a.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    tab('weather').focus();
    await press(TestKey.HOME);
    expect(document.activeElement).toBe(tab('overview'));
    await press(' '); // Space (keyCode 32; TestKey has no SPACE)
    await app.stable();
    expect(url()).toBe('/farms/FARM01');
    expect(current()).toEqual(['Overview']);
  });

  it('opens the History tab (every role) and only History is current', async () => {
    await open('/farms/FARM01', 'viewer');
    const navigated = firstValueFrom(
      TestBed.inject(Router).events.pipe(filter((e) => e instanceof NavigationEnd)),
    );
    tab('history').click();
    await navigated;
    TestBed.tick();
    const req = app.http.expectOne(
      (r) => r.url === `${TEST_API_BASE_URL}/farms/FARM01/telemetry/daily`,
    );
    req.flush({
      farmId: 'FARM01',
      from: req.request.params.get('from'),
      to: req.request.params.get('to'),
      timeZone: 'UTC',
      turbineCount: 1,
      computedAt: null,
      days: [],
    });
    await app.stable();
    expect(url()).toBe('/farms/FARM01/history');
    expect(current()).toEqual(['History']);
    expect(app.text(q('farm-history-empty'))).toBe('No daily history yet for this farm.');
    expect(TestBed.inject(Title).getTitle()).toBe('Prairie Ridge · History · Nextera');
    expect(q('nav-farms')!.getAttribute('aria-current')).toBe('page');
    app.http.verify();
  });

  it('opens the Weather history tab from a deep link, for a viewer too', async () => {
    await open('/farms/FARM02/weather', 'viewer');
    expect(app.text(app.root().querySelector('h1'))).toBe('High Plains FARM02');
    expect(current()).toEqual(['Weather history']);
    expect(tab('overview').getAttribute('href')).toBe('/farms/FARM02');
    expect(app.text(q('weather-history-empty'))).toBe('No weather synced for these days.');
    expect(q('nav-farms')!.getAttribute('aria-current')).toBe('page');
    q<HTMLAnchorElement>('back-to-farms')!.click();
    await app.stable();
    expect(url()).toBe('/farms');
  });

  it('keeps the turbine page (no farm tabs) and its breadcrumb back to the farm Overview', async () => {
    await open('/farms/FARM01/turbines/TURB001');
    expect(app.text(app.root().querySelector('h1'))).toBe('TURB001 Prairie Ridge');
    expect(q('farm-tabs')).toBeNull();

    q('breadcrumb')!.querySelector<HTMLAnchorElement>('a[href="/farms/FARM01"]')!.click();
    await app.stable();
    expect(url()).toBe('/farms/FARM01');
    expect(current()).toEqual(['Overview']);
  });

  it('shows no tabs for an unknown farm', async () => {
    await open('/farms/FARM99');
    expect(app.text(q('farm-not-found'))).toBe('Farm FARM99 was not found.');
    expect(q('farm-tabs')).toBeNull();
  });
});
