import type { MessageEvent } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { NEVER, Subject, of } from 'rxjs';
import { EventsController, HEARTBEAT_MS } from './events.controller.js';
import { EventsService } from './events.service.js';

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

  it('passes Last-Event-ID through for resume', () => {
    events.stream.mockReturnValue(NEVER);

    controller.stream('42-0').subscribe().unsubscribe();

    expect(events.stream).toHaveBeenCalledWith('42-0');
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
      .stream(undefined, {
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
