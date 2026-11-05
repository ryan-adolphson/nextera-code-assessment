import type { MessageEvent } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import { NEVER, Subject, of } from 'rxjs';
import { EventsController, HEARTBEAT_MS } from './events.controller.js';
import { EventsService, type WriteGate } from './events.service.js';

describe('EventsController', () => {
  let controller: EventsController;
  let shutdown$: Subject<void>;
  const events = {
    stream: vi.fn(),
    get shutdown$() {
      return shutdown$;
    },
  };

  beforeEach(async () => {
    shutdown$ = new Subject<void>();
    events.stream.mockReset();
    const moduleRef = await Test.createTestingModule({
      controllers: [EventsController],
      providers: [{ provide: EventsService, useValue: events }],
    }).compile();
    controller = moduleRef.get(EventsController);
  });

  afterEach(() => vi.useRealTimers());

  it('maps domain events to named SSE messages with their stream id', () => {
    events.stream.mockReturnValue(
      of({
        id: '1-0',
        type: 'telemetry.received',
        data: { turbineId: 'TURB001' },
      }),
    );
    const received: MessageEvent[] = [];

    controller
      .stream()
      .subscribe((e) => received.push(e))
      .unsubscribe();

    expect(received).toEqual([
      { id: '1-0', type: 'telemetry.received', data: { turbineId: 'TURB001' } },
    ]);
  });

  it('gives a reading the last global id, never a counter id that would overwrite the resume cursor', () => {
    events.stream.mockReturnValue(
      of(
        { type: 'telemetry.received', data: { n: 1 } },
        { id: '7-1', type: 'fleet.tick', data: {} },
        { type: 'telemetry.received', data: { n: 2 } },
      ),
    );
    const received: MessageEvent[] = [];

    controller
      .stream('5-0', { turbines: ['TURB001'] })
      .subscribe((e) => received.push(e))
      .unsubscribe();

    expect(received.map((e) => e.id)).toEqual(['5-0', '7-1', '7-1']);
    expect(events.stream).toHaveBeenCalledWith('5-0', ['TURB001'], undefined);
  });

  it('starts with an empty id when there is no cursor yet', () => {
    events.stream.mockReturnValue(of({ type: 'telemetry.received', data: {} }));
    const received: MessageEvent[] = [];
    controller
      .stream('garbage', { turbines: ['TURB001'] })
      .subscribe((e) => received.push(e))
      .unsubscribe();
    expect(received[0].id).toBe('');
  });

  it('holds readings back while the socket needs a drain', () => {
    events.stream.mockReturnValue(NEVER);
    const socket = new EventEmitter() as EventEmitter & {
      writableNeedDrain: boolean;
    };
    socket.writableNeedDrain = true;

    controller
      .stream(undefined, { turbines: ['A'] }, undefined, { socket } as never)
      .subscribe()
      .unsubscribe();

    const gate = events.stream.mock.calls[0][2] as WriteGate;
    expect(gate.blocked()).toBe(true);
    const callback = vi.fn();
    const cancel = gate.onDrain(callback);
    socket.emit('drain');
    expect(callback).toHaveBeenCalledOnce();
    gate.onDrain(callback)();
    socket.emit('drain');
    expect(callback).toHaveBeenCalledOnce();
    cancel();
  });

  it('passes Last-Event-ID through for resume', () => {
    events.stream.mockReturnValue(NEVER);

    controller.stream('42-0').subscribe().unsubscribe();

    expect(events.stream).toHaveBeenCalledWith('42-0', undefined, undefined);
  });

  it(`sends a ping every ${HEARTBEAT_MS}ms`, () => {
    vi.useFakeTimers();
    events.stream.mockReturnValue(NEVER);
    const received: MessageEvent[] = [];
    const sub = controller.stream().subscribe((e) => received.push(e));

    vi.advanceTimersByTime(HEARTBEAT_MS * 2);

    expect(received).toEqual([
      { type: 'ping', data: '' },
      { type: 'ping', data: '' },
    ]);
    sub.unsubscribe();
  });

  it("ends the stream when the user's access token expires", () => {
    vi.useFakeTimers({ now: new Date('2026-10-07T12:00:00Z') });
    events.stream.mockReturnValue(NEVER);
    const complete = vi.fn();
    controller
      .stream(undefined, undefined, {
        id: 'u',
        email: 'viewer@nextera.local',
        role: 'viewer',
        expiresAt: new Date('2026-10-07T12:10:00Z'),
      })
      .subscribe({ complete });

    vi.advanceTimersByTime(10 * 60_000 - 1);
    expect(complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(complete).toHaveBeenCalled();
  });

  it('completes the stream (heartbeat included) on shutdown', () => {
    vi.useFakeTimers();
    events.stream.mockReturnValue(NEVER);
    const complete = vi.fn();
    controller.stream().subscribe({ complete });

    shutdown$.next();

    expect(complete).toHaveBeenCalled();
  });
});
