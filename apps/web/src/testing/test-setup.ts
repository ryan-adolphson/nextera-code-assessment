// jsdom has no ResizeObserver; the charts only need observe/disconnect (jsdom has no layout).
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
