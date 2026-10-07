import { ChangeDetectionStrategy, Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TOOLTIP_CLOSE_DELAY_MS, Tooltip } from './tooltip';

@Component({
  imports: [Tooltip],
  template: `
    <app-tooltip testId="tip-a">
      <span>Error</span>
      <ul tooltip-content>
        <li>Error: Gearbox temperature 126.5 °C &gt; 120</li>
        <li>Warning: Gearbox temperature 126.5 °C &gt; 90</li>
      </ul>
    </app-tooltip>
    <app-tooltip testId="tip-b">
      <span>Warning</span>
      <p tooltip-content>Second</p>
    </app-tooltip>
    <button type="button" data-testid="elsewhere">Elsewhere</button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {}

describe('Tooltip', () => {
  let fixture: ComponentFixture<Host>;
  const root = () => fixture.nativeElement as HTMLElement;
  const triggers = () => [...root().querySelectorAll<HTMLElement>('[data-testid=tooltip-trigger]')];
  const tip = (id = 'tip-a') => root().querySelector<HTMLElement>(`[data-testid=${id}]`)!;
  const isOpen = (id = 'tip-a') => tip(id).hasAttribute('data-open') && !tip(id).hidden;
  const fire = async (el: Element, type: string) => {
    el.dispatchEvent(new Event(type));
    fixture.detectChanges();
  };
  const esc = async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  });
  afterEach(() => {
    fixture.destroy();
    (fixture.nativeElement as HTMLElement).remove();
    vi.useRealTimers();
  });

  it('wires a trigger button to a role=tooltip element by aria-describedby', () => {
    const [trigger] = triggers();
    expect([trigger.tagName, trigger.getAttribute('type')]).toEqual(['BUTTON', 'button']);
    expect(tip().getAttribute('role')).toBe('tooltip');
    expect(tip().id).toMatch(/^tooltip-\d+$/);
    expect(trigger.getAttribute('aria-describedby')).toBe(tip().id);
    expect(tip(`tip-b`).id).not.toBe(tip().id);
    // Hidden until needed, but still the description (screen readers read hidden descriptions).
    expect(isOpen()).toBe(false);
    expect(tip().hidden).toBe(true);
    expect(trigger.textContent?.trim()).toBe('Error');
    expect([...tip().querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      'Error: Gearbox temperature 126.5 °C > 120',
      'Warning: Gearbox temperature 126.5 °C > 90',
    ]);
  });

  it('opens on mouseenter and closes after the grace delay on mouseleave', async () => {
    const [trigger] = triggers();
    await fire(trigger, 'mouseenter');
    expect(isOpen()).toBe(true);
    expect(tip().getAttribute('data-placement')).toMatch(/^(top|bottom)$/);

    await fire(trigger, 'mouseleave');
    expect(isOpen()).toBe(true); // still within the grace delay
    await vi.advanceTimersByTimeAsync(TOOLTIP_CLOSE_DELAY_MS - 1);
    expect(isOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    fixture.detectChanges();
    expect(isOpen()).toBe(false);
  });

  it('stays open when the pointer moves onto the tooltip, closes after leaving it', async () => {
    const [trigger] = triggers();
    await fire(trigger, 'mouseenter');
    await fire(trigger, 'mouseleave');
    await vi.advanceTimersByTimeAsync(TOOLTIP_CLOSE_DELAY_MS / 2);
    await fire(tip(), 'mouseenter');
    await vi.advanceTimersByTimeAsync(TOOLTIP_CLOSE_DELAY_MS * 5);
    expect(isOpen()).toBe(true); // persistent while hovered

    await fire(tip(), 'mouseleave');
    await vi.advanceTimersByTimeAsync(TOOLTIP_CLOSE_DELAY_MS);
    fixture.detectChanges();
    expect(isOpen()).toBe(false);
  });

  it('opens on focus, stays open while focused, closes on blur', async () => {
    const [trigger] = triggers();
    trigger.focus();
    fixture.detectChanges();
    expect(isOpen()).toBe(true);

    // The pointer passing over and away does not close a focused tooltip.
    await fire(trigger, 'mouseenter');
    await fire(trigger, 'mouseleave');
    await vi.advanceTimersByTimeAsync(TOOLTIP_CLOSE_DELAY_MS * 5);
    expect(isOpen()).toBe(true);

    trigger.blur();
    fixture.detectChanges();
    expect(isOpen()).toBe(false);
  });

  it('stays open on blur while still hovered', async () => {
    const [trigger] = triggers();
    trigger.focus();
    await fire(trigger, 'mouseenter');
    trigger.blur();
    fixture.detectChanges();
    expect(isOpen()).toBe(true);
  });

  it('closes on Esc without moving focus, and reopens on the next hover', async () => {
    const [trigger] = triggers();
    trigger.focus();
    await fire(trigger, 'mouseenter');
    expect(isOpen()).toBe(true);

    await esc();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(trigger);

    await fire(trigger, 'mouseenter');
    expect(isOpen()).toBe(true);
  });

  it('opens on click/tap and closes on a pointerdown elsewhere (touch)', async () => {
    const [trigger] = triggers();
    await fire(trigger, 'click');
    expect(isOpen()).toBe(true);

    // A press inside the tooltip keeps it.
    tip().dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(isOpen()).toBe(true);

    root()
      .querySelector('[data-testid=elsewhere]')!
      .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    fixture.detectChanges();
    expect(isOpen()).toBe(false);
  });

  it('keeps only one tooltip open at a time', async () => {
    const [a, b] = triggers();
    a.focus();
    fixture.detectChanges();
    expect(isOpen('tip-a')).toBe(true);

    await fire(b, 'mouseenter');
    expect(isOpen('tip-b')).toBe(true);
    expect(isOpen('tip-a')).toBe(false);
  });

  it('positions above the trigger, flips below at the top edge, clamps to the viewport', async () => {
    const [trigger] = triggers();
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect;
    Object.defineProperty(tip(), 'offsetWidth', { configurable: true, value: 200 });
    Object.defineProperty(tip(), 'offsetHeight', { configurable: true, value: 50 });
    const viewport = document.documentElement;
    Object.defineProperty(viewport, 'clientWidth', { configurable: true, value: 400 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 600 });
    try {
      // Room above: centred above, 6px gap.
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(150, 300, 60, 20));
      await fire(trigger, 'mouseenter');
      expect(tip().getAttribute('data-placement')).toBe('top');
      expect([tip().style.top, tip().style.left]).toEqual(['244px', '80px']);
      await esc();

      // Near the top and the right edge: below, clamped to 400 - 200 - 8.
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(370, 20, 20, 20));
      await fire(trigger, 'mouseenter');
      expect(tip().getAttribute('data-placement')).toBe('bottom');
      expect([tip().style.top, tip().style.left]).toEqual(['46px', '192px']);
      await esc();

      // Near the left edge: clamped to the 8px margin.
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(0, 300, 20, 20));
      await fire(trigger, 'mouseenter');
      expect(tip().style.left).toBe('8px');

      // Scrolled out of view: closes.
      vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rect(0, -100, 20, 20));
      window.dispatchEvent(new Event('scroll'));
      fixture.detectChanges();
      expect(isOpen()).toBe(false);
    } finally {
      delete (viewport as unknown as Record<string, unknown>)['clientWidth'];
      delete (viewport as unknown as Record<string, unknown>)['clientHeight'];
    }
  });
});

describe('Tooltip with the Popover API', () => {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  afterEach(() => {
    delete proto['showPopover'];
    delete proto['hidePopover'];
  });

  it('shows and hides the tooltip in the top layer (popover="manual")', async () => {
    let showing = false;
    const show = vi.fn(() => (showing = true));
    const hide = vi.fn(() => (showing = false));
    proto['showPopover'] = show;
    proto['hidePopover'] = hide;
    const matches = HTMLElement.prototype.matches;
    vi.spyOn(HTMLElement.prototype, 'matches').mockImplementation(function (
      this: HTMLElement,
      selector: string,
    ) {
      return selector === ':popover-open' ? showing : matches.call(this, selector);
    });

    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const tip = root.querySelector<HTMLElement>('[data-testid=tip-a]')!;
    const trigger = root.querySelector<HTMLElement>('[data-testid=tooltip-trigger]')!;
    expect(tip.getAttribute('popover')).toBe('manual');
    expect(tip.hasAttribute('hidden')).toBe(false); // the UA hides closed popovers

    trigger.dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    expect(show).toHaveBeenCalledOnce();
    expect(tip.hasAttribute('data-open')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(hide).toHaveBeenCalledOnce();
    expect(tip.hasAttribute('data-open')).toBe(false);
    fixture.destroy();
  });
});
