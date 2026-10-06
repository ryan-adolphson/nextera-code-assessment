import { TestBed } from '@angular/core/testing';
import { SseEvent, SseService } from './sse.service';

/** Stand-in for the browser EventSource that supports named events. */
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

  /** Network drop: the browser will retry by itself. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  /** Permanent failure: the browser gives up. */
  fail(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

describe('SseService', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  const connect = (types = ['telemetry.received']) => {
    const received: SseEvent<unknown>[] = [];
    const errors: unknown[] = [];
    const sub = TestBed.inject(SseService)
      .connect('http://api/events', types)
      .subscribe({ next: (e) => received.push(e), error: (e) => errors.push(e) });
    return { received, errors, sub, source: FakeEventSource.instances[0] };
  };

  it('reports connecting, then open', () => {
    const { received, source } = connect();
    source.open();

    expect(received).toEqual([
      { kind: 'status', status: 'connecting' },
      { kind: 'status', status: 'open' },
    ]);
    expect(source.url).toBe('http://api/events');
  });

  it('emits parsed named events with their id and ignores unsubscribed types', () => {
    const { received, source } = connect(['telemetry.received', 'alert.raised']);

    source.emit('telemetry.received', { id: 'a' }, '5-0');
    source.emit('alert.raised', { id: 'a' }, '6-0');
    source.emit('something.else', { id: 'b' });

    expect(received.filter((e) => e.kind === 'message')).toEqual([
      { kind: 'message', id: '5-0', type: 'telemetry.received', data: { id: 'a' } },
      { kind: 'message', id: '6-0', type: 'alert.raised', data: { id: 'a' } },
    ]);
  });

  it('reports reconnecting on a dropped connection without erroring', () => {
    const { received, errors, source } = connect();
    source.drop();

    expect(received.at(-1)).toEqual({ kind: 'status', status: 'reconnecting' });
    expect(errors).toEqual([]);
  });

  it('errors once the connection is permanently closed', () => {
    const { errors, source } = connect();
    source.fail();

    expect(errors).toHaveLength(1);
  });

  it('closes the EventSource on unsubscribe', () => {
    const { sub, source } = connect();
    sub.unsubscribe();

    expect(source.close).toHaveBeenCalled();
  });
});
