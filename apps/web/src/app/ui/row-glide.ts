import { MediaMatcher } from '@angular/cdk/layout';
import { Directive, ElementRef, Injector, afterNextRender, inject } from '@angular/core';

/** How long a row takes to glide to its new place. */
export const ROW_GLIDE_MS = 500;

/** What a row looked like before a re-order. */
interface RowBefore {
  top: number;
  /** Start times of its running CSS animations, by name. */
  animations: Map<string, number>;
}

/**
 * Animates a live re-order of a table's rows (FLIP, Web Animations API, `transform` on the `<tr>`):
 * wrap the change that re-orders them in `reorder()`, and each row that stays on the page glides
 * from its old place. Rows are matched by element, so the table needs `[trackBy]`; rows entering or
 * leaving just appear or disappear. Nothing else animates, so a sort, filter or page change (not
 * wrapped) stays instant. `prefers-reduced-motion` turns the glide off.
 *
 * Moving a row in the DOM blurs what is focused in it and restarts its CSS animations, so
 * `reorder()` also puts the focus back and resumes those animations where they were (with or
 * without the glide): the live flash always finishes on time.
 */
@Directive({ selector: 'table[appRowGlide]' })
export class RowGlide {
  private readonly table = inject<ElementRef<HTMLTableElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly reducedMotion = inject(MediaMatcher).matchMedia(
    '(prefers-reduced-motion: reduce)',
  );
  private running: Animation[] = [];

  /** Runs `change` (which re-orders the rows on the next render) and animates the difference. */
  reorder(change: () => void): void {
    this.cancel();
    const active = this.table.ownerDocument.activeElement as HTMLElement | null;
    const focused = this.table.contains(active) ? active : null;
    // offsetTop, not the screen position: unaffected by scrolling before the next render.
    const before = new Map<HTMLElement, RowBefore>(
      this.rows().map((row) => [row, { top: row.offsetTop, animations: cssAnimationStarts(row) }]),
    );

    change();

    afterNextRender(
      () => {
        if (focused?.isConnected) focused.focus({ preventScroll: true });
        for (const row of this.rows()) {
          const was = before.get(row);
          if (!was) continue;
          resumeCssAnimations(row, was.animations);
          const offset = was.top - row.offsetTop;
          if (offset && !this.reducedMotion.matches) this.glide(row, offset);
        }
      },
      { injector: this.injector },
    );
  }

  /** Ends the glides in flight at once (the rows are already in their new places). */
  cancel(): void {
    for (const animation of this.running) animation.cancel();
    this.running = [];
  }

  private glide(row: HTMLElement, offset: number): void {
    this.running.push(
      row.animate([{ transform: `translateY(${offset}px)` }, { transform: 'none' }], {
        duration: ROW_GLIDE_MS,
        easing: 'ease-out',
      }),
    );
  }

  private rows(): HTMLElement[] {
    return [...this.table.querySelectorAll<HTMLElement>(':scope > tbody > tr')];
  }
}

function cssAnimations(row: HTMLElement): CSSAnimation[] {
  return row.getAnimations().filter((a): a is CSSAnimation => 'animationName' in a);
}

function cssAnimationStarts(row: HTMLElement): Map<string, number> {
  const starts = new Map<string, number>();
  for (const animation of cssAnimations(row)) {
    if (animation.startTime !== null) {
      starts.set(animation.animationName, animation.startTime as number);
    }
  }
  return starts;
}

/** A moved row's CSS animation starts over: put it back on its original timeline. */
function resumeCssAnimations(row: HTMLElement, starts: Map<string, number>): void {
  for (const animation of cssAnimations(row)) {
    const start = starts.get(animation.animationName);
    if (start !== undefined) animation.startTime = start;
  }
}
