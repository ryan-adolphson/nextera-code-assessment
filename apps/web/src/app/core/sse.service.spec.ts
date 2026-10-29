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

  it('reports reconnecting, then open again, on the same EventSource after a drop', () => {
    const { received, source } = connect();
    source.open();
    source.drop();
    source.open();

    expect(received.map((e) => (e.kind === 'status' ? e.status : e.kind))).toEqual([
      'connecting',
      'open',
      'reconnecting',
      'open',
    ]);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  describe('a named event with malformed JSON', () => {
    it('is not emitted, and the stream neither errors nor closes', () => {
      const { received, errors, source } = connect();
      source.open();

      source.emitRaw('telemetry.received', '{"id": "a"', '7-0');

      expect(received.filter((e) => e.kind === 'message')).toEqual([]);
      expect(errors).toEqual([]);
      expect(source.close).not.toHaveBeenCalled();
    });

    it('does not stop the next valid event from arriving', () => {
      const { received, source } = connect();
      source.open();

      source.emitRaw('telemetry.received', 'not json', '7-0');
      source.emit('telemetry.received', { id: 'b' }, '8-0');

      expect(received.filter((e) => e.kind === 'message')).toEqual([
        { kind: 'message', id: '8-0', type: 'telemetry.received', data: { id: 'b' } },
      ]);
    });

    it('skips it without throwing an uncaught error', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { source } = connect();
        source.open();

        expect(source.emitRaw('telemetry.received', 'not json', '7-0')).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0].join(' ')).toMatch(/telemetry\.received.*7-0/);
        expect(warn.mock.calls[0].join(' ')).not.toContain('not json');
      } finally {
        warn.mockRestore();
      }
    });
  });
});
