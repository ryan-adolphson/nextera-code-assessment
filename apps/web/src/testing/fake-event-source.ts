/**
 * Stand-in for the browser EventSource that supports named events. Install it with
 * `vi.stubGlobal('EventSource', FakeEventSource)` and reset `FakeEventSource.instances` per test.
 */
export class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly close = vi.fn(() => (this.readyState = FakeEventSource.CLOSED));
  private readonly listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (e: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  emit(type: string, data: unknown, lastEventId = '1-0'): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data), lastEventId });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  /** Network drop: the browser will retry by itself (same EventSource, sends Last-Event-ID). */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  /** Failed connection (e.g. a 503 on reconnect): the browser gives up on this EventSource. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}
