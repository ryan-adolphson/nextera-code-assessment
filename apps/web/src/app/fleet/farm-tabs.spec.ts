import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { Role } from '../core/auth/roles';
import { openFleet } from './testing';

/**
 * A farm's routed tabs: Overview (/farms/:farmId) and Weather history (/farms/:farmId/weather),
 * page links under the farm header. The fake WeatherApi answers at once with no weather.
 */
describe('Farm tabs (/farms/:farmId, /farms/:farmId/weather)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;

  async function open(url: string, role: Role = 'admin') {
    app = await openFleet(url, () => CLOCK, undefined, undefined, role);
    await app.stable();
  }
  const q = <T extends Element = HTMLElement>(id: string) =>
    app.root().querySelector<T>(`[data-testid=${id}]`);
  const tab = (id: 'overview' | 'weather') => q<HTMLAnchorElement>(`farm-tab-${id}`)!;
  const current = () =>
    [...app.root().querySelectorAll('[data-testid=farm-tabs] a')]
      .filter((a) => a.getAttribute('aria-current') === 'page')
      .map((a) => app.text(a));
  const url = () => TestBed.inject(Router).url;

  it('shows both tabs under the farm header on the Overview, with Overview current', async () => {
    await open('/farms/FARM01');
    const nav = q('farm-tabs')!;
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('Farm');
    expect(
      [...nav.querySelectorAll('a')].map((a) => [app.text(a), a.getAttribute('href')]),
    ).toEqual([
      ['Overview', '/farms/FARM01'],
      ['Weather history', '/farms/FARM01/weather'],
    ]);
    expect(current()).toEqual(['Overview']);
    // The header comes first: h1, then the tabs, then the page.
    const h1 = app.root().querySelector('h1')!;
    expect(app.text(h1)).toBe('Prairie Ridge FARM01');
    expect(h1.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      nav.compareDocumentPosition(q('farm-weather')!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The side nav's Farms item stays current.
    expect(q('nav-farms')!.getAttribute('aria-current')).toBe('page');
  });

  it('switches between the tabs with the links (bookmarkable URLs)', async () => {
    await open('/farms/FARM01');
    tab('weather').click();
    await app.stable();
    expect(url()).toBe('/farms/FARM01/weather');
    expect(current()).toEqual(['Weather history']);
    expect(q('weather-history-range')).not.toBeNull();
    expect(q('farm-weather')).toBeNull();
    expect(TestBed.inject(Title).getTitle()).toBe('Prairie Ridge · Weather history · Nextera');

    tab('overview').click();
    await app.stable();
    expect(url()).toBe('/farms/FARM01');
    expect(current()).toEqual(['Overview']);
    expect(q('farm-weather')).not.toBeNull();
    expect(q('turbines')).not.toBeNull();
    expect(TestBed.inject(Title).getTitle()).toBe('Farm · Nextera');
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
