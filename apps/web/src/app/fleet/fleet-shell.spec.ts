import { Title } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { openFleet, reading } from './testing';

/** The shell's side navigation, driven through the real routes. */
describe('FleetShell navigation', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z'); // 5 min after the fixture's readings
  let clockNow: number;
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(() => (clockNow = CLOCK));

  const open = async (url: string) => (app = await openFleet(url, () => clockNow));
  const navLinks = () => [
    ...app.root().querySelectorAll<HTMLAnchorElement>('nav[aria-label=Main] a'),
  ];
  const link = (id: string) =>
    app.root().querySelector<HTMLAnchorElement>(`[data-testid=nav-${id}]`)!;
  const current = () =>
    navLinks()
      .filter((a) => a.getAttribute('aria-current') === 'page')
      .map((a) => a.dataset['testid']);
  const toggle = () => app.root().querySelector<HTMLButtonElement>('[data-testid=nav-toggle]')!;
  const nav = () => app.root().querySelector<HTMLElement>('#main-nav')!;
  const url = () => TestBed.inject(Router).url;
  /** The text a screen reader announces: content without aria-hidden parts. */
  const spoken = (el: Element) => {
    const copy = el.cloneNode(true) as Element;
    copy.querySelectorAll('[aria-hidden=true]').forEach((e) => e.remove());
    return app.text(copy);
  };

  it('shows the four sections in order, each a link', async () => {
    await open('/farms');
    expect(navLinks().map((a) => [app.text(a), a.getAttribute('href')])).toEqual([
      ['Farms', '/farms'],
      ['Turbines', '/turbines'],
      ['Alerting', '/alerting'],
      ['Reporting', '/reporting'],
    ]);
    const icons = [...app.root().querySelectorAll('nav[aria-label=Main] mat-icon')];
    expect(icons.map((i) => i.getAttribute('data-mat-icon-name'))).toEqual([
      'map',
      'wind-power',
      'notifications',
      'bar-chart',
    ]);
    for (const icon of icons) {
      expect(icon.getAttribute('aria-hidden')).toBe('true');
      expect(icon.querySelector('svg')).not.toBeNull(); // inline Material Symbol, no font
    }
  });

  it.each([
    ['/farms', 'nav-farms'],
    ['/farms/FARM01', 'nav-farms'],
    ['/farms/FARM01/turbines/TURB001', 'nav-farms'],
    ['/turbines', 'nav-turbines'],
    ['/alerting', 'nav-alerting'],
    ['/alerting/rules', 'nav-alerting'],
    ['/reporting', 'nav-reporting'],
  ])('marks only the current section on %s', async (path, active) => {
    await open(path);
    expect(current()).toEqual([active]);
  });

  it('opens the fleet overview at /farms, from / and from unknown URLs', async () => {
    await open('/');
    expect(url()).toBe('/farms');
    expect(app.text(app.root().querySelector('h1'))).toBe('Fleet overview');
    expect(current()).toEqual(['nav-farms']);

    await app.harness.navigateByUrl('/nowhere');
    expect(url()).toBe('/farms');
  });

  it('moves the current marker when navigating, without reloading or reconnecting', async () => {
    await open('/farms');
    link('turbines').click();
    await app.stable();
    expect(url()).toBe('/turbines');
    expect(current()).toEqual(['nav-turbines']);

    link('reporting').click();
    await app.stable();
    expect(current()).toEqual(['nav-reporting']);
    expect(app.api.farms).toHaveBeenCalledTimes(1);
    expect(app.sse.connect).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['/farms', 'Fleet overview · Nextera'],
    ['/farms/FARM01', 'Farm · Nextera'],
    ['/farms/FARM01/turbines/TURB001', 'Turbine · Nextera'],
    ['/turbines', 'Turbines · Nextera'],
    ['/alerting', 'Alerting · Nextera'],
    ['/reporting', 'Reporting · Nextera'],
  ])('titles %s "%s"', async (path, title) => {
    await open(path);
    expect(TestBed.inject(Title).getTitle()).toBe(title);
  });

  it('gives /turbines a window-high layout (route data fillViewport) and the other pages none', async () => {
    const shell = () => app.root().querySelector('[data-testid=shell]')!;
    const main = () => app.root().querySelector('main')!;
    await open('/turbines');
    expect(shell().hasAttribute('data-fill')).toBe(true);
    // Window-high flex column (row from md up); main fills the rest and is the fallback scroller.
    for (const c of ['data-fill:h-dvh', 'data-fill:flex-col', 'md:data-fill:flex-row']) {
      expect(shell().classList).toContain(c);
    }
    for (const c of ['group-data-fill/shell:min-h-0', 'group-data-fill/shell:overflow-y-auto']) {
      expect(main().classList).toContain(c);
    }
    expect(main().firstElementChild!.classList).toContain('group-data-fill/shell:flex-1');

    link('farms').click();
    await app.stable();
    expect(shell().hasAttribute('data-fill')).toBe(false);
    link('turbines').click();
    await app.stable();
    expect(shell().hasAttribute('data-fill')).toBe(true);
  });

  it('keeps the app name and live status in the sidebar', async () => {
    await open('/turbines');
    const sidebar = app.root().querySelector('[data-testid=sidebar]')!;
    expect(sidebar.querySelector('[data-testid=brand]')!.getAttribute('href')).toBe('/farms');
    expect(app.text(sidebar.querySelector('[data-testid=live-status]'))).toBe('Connecting…');
  });

  describe('alert count on the Alerting item', () => {
    afterEach(() => vi.useRealTimers());

    it('shows none while every turbine reports', async () => {
      await open('/farms');
      expect(link('alerting').querySelector('[data-testid=alert-count]')).toBeNull();
      expect(spoken(link('alerting'))).toBe('Alerting');
    });

    it('counts the turbines needing attention, with accessible text, and follows live data', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true }); // timers only; the clock is NOW
      await open('/farms');
      clockNow += 11 * 60_000; // 16 min after both turbines' latest reading
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await app.stable();

      expect(app.text(link('alerting').querySelector('[data-testid=alert-count]'))).toBe('2');
      expect(spoken(link('alerting'))).toBe('Alerting, 2 alerts');
      expect(link('alerting').querySelector('[data-testid=alert-count]')!.ariaHidden).toBe('true');

      app.sse.push(reading({ timestamp: new Date(clockNow).toISOString() }));
      await app.stable();
      expect(spoken(link('alerting'))).toBe('Alerting, 1 alert');
    });
  });

  describe('narrow-screen menu', () => {
    it('starts closed and opens with its button', async () => {
      await open('/farms');
      expect(toggle().getAttribute('aria-controls')).toBe('main-nav');
      expect(nav().getAttribute('aria-label')).toBe('Main');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(nav().hasAttribute('data-open')).toBe(false);
      expect(app.text(toggle())).toBe('Menu');

      toggle().click();
      await app.stable();
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      expect(nav().hasAttribute('data-open')).toBe(true);

      toggle().click();
      await app.stable();
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
    });

    it('closes on Esc and returns focus to the button', async () => {
      await open('/farms');
      toggle().click();
      await app.stable();
      link('turbines').focus();

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await app.stable();
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(nav().hasAttribute('data-open')).toBe(false);
      expect(document.activeElement).toBe(toggle());
    });

    it('ignores Esc while closed', async () => {
      await open('/farms');
      link('turbines').focus();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await app.stable();
      expect(document.activeElement).toBe(link('turbines'));
    });

    it('closes when a page is chosen', async () => {
      await open('/farms');
      toggle().click();
      await app.stable();

      link('alerting').click();
      await app.stable();
      expect(url()).toBe('/alerting');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(nav().hasAttribute('data-open')).toBe(false);
    });
  });
});
