import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AppTimePipe } from './app-time.pipe';
import { BROWSER_TIME_ZONE, TimeZoneSettings } from './time-zone';

@Component({
  imports: [AppTimePipe],
  template: `<span data-testid="plain">{{ value() | appTime: 'MMM d, HH:mm' }}</span>
    <span data-testid="zoned">{{ value() | appTime: 'MMM d, y, HH:mm' : true }}</span>`,
})
class Host {
  readonly value = signal<string | number | Date | null | undefined>('2026-01-02T03:20:00.000Z');
}

describe('appTime pipe', () => {
  async function render(browserZone: string) {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [{ provide: BROWSER_TIME_ZONE, useValue: browserZone }],
    });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const text = (id: string) => el.querySelector(`[data-testid=${id}]`)!.textContent!.trim();
    return { fixture, text, settings: TestBed.inject(TimeZoneSettings) };
  }

  it('formats in UTC by default', async () => {
    const { text } = await render('America/Chicago');
    expect(text('plain')).toBe('Jan 2, 03:20');
    expect(text('zoned')).toBe('Jan 2, 2026, 03:20 UTC');
  });

  it.each([
    ['America/Chicago', 'Jan 1, 21:20', 'Jan 1, 2026, 21:20 CST'],
    ['Asia/Kolkata', 'Jan 2, 08:50', 'Jan 2, 2026, 08:50 GMT+5:30'],
  ])('follows a switch to local time in %s at once', async (zone, plain, zoned) => {
    const { fixture, text, settings } = await render(zone);
    settings.setMode('local');
    await fixture.whenStable();
    expect(text('plain')).toBe(plain);
    expect(text('zoned')).toBe(zoned);

    settings.setMode('utc');
    await fixture.whenStable();
    expect(text('plain')).toBe('Jan 2, 03:20');
  });

  it('shows 12-hour times, with the zone tag, and follows a live switch', async () => {
    const { fixture, text, settings } = await render('America/Chicago');
    settings.setClock('12h');
    await fixture.whenStable();
    expect(text('plain')).toBe('Jan 2, 3:20 AM');
    expect(text('zoned')).toBe('Jan 2, 2026, 3:20 AM UTC');

    settings.setMode('local');
    await fixture.whenStable();
    expect(text('plain')).toBe('Jan 1, 9:20 PM');
    expect(text('zoned')).toBe('Jan 1, 2026, 9:20 PM CST');

    settings.setClock('24h');
    await fixture.whenStable();
    expect(text('plain')).toBe('Jan 1, 21:20');
  });

  it('formats epoch ms and Dates, and shows nothing for no or an invalid time', async () => {
    const { fixture, text } = await render('America/Chicago');
    const host = fixture.componentInstance;
    host.value.set(Date.parse('2026-07-02T15:05:00Z'));
    await fixture.whenStable();
    expect(text('plain')).toBe('Jul 2, 15:05');
    host.value.set(new Date('2026-07-02T15:10:00Z'));
    await fixture.whenStable();
    expect(text('plain')).toBe('Jul 2, 15:10');
    for (const value of [null, undefined, '', 'not a date']) {
      host.value.set(value);
      await fixture.whenStable();
      expect(text('plain')).toBe('');
    }
  });
});
