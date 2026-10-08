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
