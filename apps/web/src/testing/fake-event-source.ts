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

  /**
   * A named event whose `data` is sent as is (not JSON-encoded), e.g. a malformed payload. Like a
   * browser dispatching an event, a listener that throws doesn't stop the others or the
   * connection: the browser reports the exception as uncaught (window `error`). Returns what the
   * listeners threw, so a test can assert whether anything would reach that global handler.
   */
  emitRaw(type: string, data: string, lastEventId = '1-0'): unknown[] {
    const event = new MessageEvent(type, { data, lastEventId });
    const thrown: unknown[] = [];
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        listener(event);
      } catch (error) {
        thrown.push(error);
      }
    }
    return thrown;
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
