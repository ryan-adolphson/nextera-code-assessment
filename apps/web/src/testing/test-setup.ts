// jsdom has no ResizeObserver; the charts only need observe/disconnect (jsdom has no layout).
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// jsdom has no canvas: its getContext() logs "Not implemented" and returns null. ECharts' SVG
// renderer only asks for a 2D context to measure text (zrender's platform measureText), and on
// null falls back to its built-in width table, so returning null quietly changes nothing else.
HTMLCanvasElement.prototype.getContext = (() => null) as HTMLCanvasElement['getContext'];

// jsdom has no IntersectionObserver, which `@defer (on viewport)` needs. Report every observed
// element as visible (a microtask later: Angular registers its listener after calling observe()),
// so viewport-triggered blocks render like `on immediate` in the default Playthrough mode. Specs
// that check a placeholder use DeferBlockBehavior.Manual instead.
globalThis.IntersectionObserver ??= class {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly thresholds = [0];
  private observing = true;
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element): void {
    queueMicrotask(() => {
      if (!this.observing) return;
      const rect = target.getBoundingClientRect();
      const entry = {
        target,
        isIntersecting: true,
        intersectionRatio: 1,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
        time: performance.now(),
      } as IntersectionObserverEntry;
      this.callback([entry], this as unknown as IntersectionObserver);
    });
  }
  unobserve(): void {}
  disconnect(): void {
    this.observing = false;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
} as unknown as typeof IntersectionObserver;
