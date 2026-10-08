import { TestBed } from '@angular/core/testing';
import { FakeEventSource } from '../../testing/fake-event-source';
import { SseEvent, SseService } from './sse.service';

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
