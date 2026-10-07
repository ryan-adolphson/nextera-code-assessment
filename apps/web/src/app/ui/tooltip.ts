import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

/** How long the tooltip stays after the pointer leaves, so it can move onto the tooltip. */
export const TOOLTIP_CLOSE_DELAY_MS = 200;
/** Minimum distance to the viewport edges, and the gap between trigger and tooltip. */
const VIEWPORT_MARGIN = 8;
const GAP = 6;

let nextId = 0;
/** One tooltip open at a time: opening one closes the other. */
let openTooltip: Tooltip | null = null;

/**
 * A tooltip (WCAG 1.4.13 hoverable, dismissible, persistent; 2.1.1 keyboard). The projected
 * content is the trigger, wrapped in a `<button type="button">` with a focus ring; the element
 * marked `tooltip-content` is the tooltip. A button rather than a `tabindex="0"` span because a
 * focusable generic element has no accessible name (Chrome exposes "" and screen readers then
 * announce only the description), while a button is named by its content ("Error"), takes focus
 * natively (also on tap) and clicking it really does show the tooltip. Project only
 * phrasing content without interactive elements into the trigger.
 *
 * ```html
 * <app-tooltip testId="alert-tooltip">
 *   <app-alert-level-badge level="error" />
 *   <ul tooltip-content>…</ul>
 * </app-tooltip>
 * ```
 *
 * - Opens on hover, focus and click/tap; closes when the pointer has left both the trigger and
 *   the tooltip for `TOOLTIP_CLOSE_DELAY_MS`, on blur (unless still hovered), on Esc (focus stays
 *   where it is) and on a tap/click elsewhere. Stays open while hovered or focused.
 * - Renders in the top layer (`popover="manual"`), so table scroll containers never clip it, at
 *   fixed coordinates from `getBoundingClientRect()`: above the trigger, below if there is no room,
 *   clamped to the viewport. Follows scrolling/resizing; closes when the trigger scrolls away.
 *   Without the Popover API (jsdom, old browsers) it is a `hidden`-toggled `position: fixed` box.
 * - `role="tooltip"` with an id, referenced by the trigger's `aria-describedby`, so screen
 *   readers announce the content on focus even while it is hidden.
 * - Test hooks: the trigger is `tooltip-trigger`; the tooltip has `data-testid` = `testId`,
 *   `data-open` while shown and `data-placement` (top|bottom).
 */
@Component({
  selector: 'app-tooltip',
  host: { class: 'inline-block' },
  template: `
    <button
      #trigger
      type="button"
      class="inline-flex cursor-default rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-testid="tooltip-trigger"
      [attr.aria-describedby]="id"
      (mouseenter)="onPointerEnter()"
      (mouseleave)="onPointerLeave()"
      (focus)="onFocus()"
      (blur)="onBlur()"
      (click)="onFocus()"
    >
      <ng-content />
    </button>
    <div
      #tip
      role="tooltip"
      class="fixed inset-auto z-50 m-0 w-max max-w-[min(20rem,calc(100vw-16px))] overflow-visible rounded-md border border-line bg-surface px-3 py-2 text-left text-sm whitespace-normal text-ink shadow-md"
      [id]="id"
      [attr.popover]="usePopover ? 'manual' : null"
      [attr.hidden]="usePopover || open() ? null : ''"
      [attr.data-testid]="testId()"
      [attr.data-open]="open() ? '' : null"
      [attr.data-placement]="placement()"
      (mouseenter)="onPointerEnter()"
      (mouseleave)="onPointerLeave()"
    >
      <ng-content select="[tooltip-content]" />
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Tooltip {
  /** `data-testid` of the tooltip element. */
  readonly testId = input('tooltip');

  protected readonly id = `tooltip-${nextId++}`;
  /** Feature detection: the top layer when the browser has the Popover API. */
  protected readonly usePopover = typeof HTMLElement.prototype.showPopover === 'function';
  readonly open = signal(false);
  protected readonly placement = signal<'top' | 'bottom'>('top');

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly trigger = viewChild.required<ElementRef<HTMLElement>>('trigger');
  private readonly tip = viewChild.required<ElementRef<HTMLElement>>('tip');
  private hovered = false;
  private focused = false;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.hide());
  }

  protected onPointerEnter(): void {
    this.hovered = true;
    this.cancelClose();
    this.show();
  }

  /** Grace period: moving from the trigger onto the tooltip (or back) keeps it open. */
  protected onPointerLeave(): void {
    this.hovered = false;
    this.cancelClose();
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      if (!this.focused) this.hide();
    }, TOOLTIP_CLOSE_DELAY_MS);
  }

  protected onFocus(): void {
    this.focused = true;
    this.show();
  }

  protected onBlur(): void {
    this.focused = false;
    if (!this.hovered) this.hide();
  }

  private show(): void {
    if (this.open()) return;
    if (openTooltip && openTooltip !== this) openTooltip.hide();
    openTooltip = this;
    const tip = this.tip().nativeElement;
    if (this.usePopover) tip.showPopover();
    else tip.hidden = false; // now, so it can be measured (the binding agrees after the next render)
    this.open.set(true);
    document.addEventListener('keydown', this.onKeydown);
    document.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('scroll', this.reposition, { capture: true, passive: true });
    window.addEventListener('resize', this.reposition, { passive: true });
    this.reposition();
  }

  private hide(): void {
    this.cancelClose();
    document.removeEventListener('keydown', this.onKeydown);
    document.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('scroll', this.reposition, { capture: true });
    window.removeEventListener('resize', this.reposition);
    if (openTooltip === this) openTooltip = null;
    if (!this.open()) return;
    const tip = this.tip().nativeElement;
    if (this.usePopover) {
      if (tip.matches(':popover-open')) tip.hidePopover();
    } else {
      tip.hidden = true;
    }
    this.open.set(false);
  }

  private cancelClose(): void {
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  /** Esc dismisses it without moving focus; hovering or focusing again reopens it. */
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.hovered = false;
      this.hide();
    }
  };

  /** A tap or click anywhere else closes it (touch has no mouseleave). */
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Node && this.host.contains(event.target)) return;
    this.hovered = false;
    this.focused = false;
    this.hide();
  };

  /**
   * Fixed coordinates in the viewport: centred above the trigger, below it when there is no room
   * above, clamped horizontally with an 8px margin. Closes when the trigger is out of view.
   */
  private readonly reposition = (): void => {
    const t = this.trigger().nativeElement.getBoundingClientRect();
    const tip = this.tip().nativeElement;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    if (t.bottom < 0 || t.top > vh || t.right < 0 || t.left > vw) {
      this.hide();
      return;
    }
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let top = t.top - GAP - height;
    let placement: 'top' | 'bottom' = 'top';
    if (top < VIEWPORT_MARGIN) {
      top = t.bottom + GAP;
      placement = 'bottom';
    }
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(t.left + t.width / 2 - width / 2, vw - width - VIEWPORT_MARGIN),
    );
    tip.style.top = `${Math.round(top)}px`;
    tip.style.left = `${Math.round(left)}px`;
    this.placement.set(placement);
  };
}
