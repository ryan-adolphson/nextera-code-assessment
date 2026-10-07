import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, throwError } from 'rxjs';
import { latestLoad } from './latest-load';

describe('latestLoad', () => {
  /**
   * A load whose answers the test controls, one Subject per request. The resource sends a request
   * on the next change detection (`TestBed.tick()`) and commits an answer a microtask after it
   * arrives, so `answer` waits a task. No `whenStable()`: a loading resource is a pending task.
   */
  function setup() {
    const pending = new Map<string, Subject<string>>();
    const requested: string[] = [];
    const onLoad = vi.fn();
    const loader = runInInjectionContext(TestBed.inject(Injector), () =>
      latestLoad((id: string) => {
        requested.push(id);
        if (id === 'boom') return throwError(() => new Error('500'));
        const answer = new Subject<string>();
        pending.set(id, answer);
        return answer;
      }, onLoad),
    );
    const run = (id: string) => {
      loader.run(id);
      TestBed.tick();
    };
    const answer = async (id: string, value: string) => {
      pending.get(id)!.next(value);
      pending.get(id)!.complete();
      await new Promise((resolve) => setTimeout(resolve));
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve));
    return { loader, run, answer, settle, requested, onLoad };
  }

  it('keeps the answer as signals and calls onLoad', async () => {
    const { loader, run, answer, onLoad } = setup();
    expect([loader.value(), loader.loading(), loader.failed()]).toEqual([null, false, false]);

    run('a');
    expect(loader.loading()).toBe(true);
    await answer('a', 'A');
    expect([loader.value(), loader.loading(), loader.failed()]).toEqual(['A', false, false]);
    expect(onLoad).toHaveBeenCalledExactlyOnceWith('A');
  });

  it('drops the answer to an older request (only the latest counts)', async () => {
    const { loader, run, answer, requested, onLoad } = setup();
    run('a');
    run('b');
    expect(requested).toEqual(['a', 'b']);
    await answer('a', 'A'); // too late: 'a' was cancelled by 'b'
    expect(loader.value()).toBeNull();
    expect(loader.loading()).toBe(true);
    await answer('b', 'B');
    expect(loader.value()).toBe('B');
    expect(onLoad).toHaveBeenCalledExactlyOnceWith('B');
  });

  it('keeps the value while the next request loads', async () => {
    const { loader, run, answer } = setup();
    run('a');
    await answer('a', 'A');

    run('b');
    expect([loader.value(), loader.loading(), loader.failed()]).toEqual(['A', true, false]);
    await answer('b', 'B');
    expect([loader.value(), loader.loading()]).toEqual(['B', false]);
  });

  it('sends the same request again when it is run again', async () => {
    const { loader, run, answer, requested, onLoad } = setup();
    run('a');
    await answer('a', 'A1');
    run('a');
    expect(requested).toEqual(['a', 'a']);
    expect(loader.loading()).toBe(true);
    await answer('a', 'A2');
    expect(loader.value()).toBe('A2');
    expect(onLoad.mock.calls).toEqual([['A1'], ['A2']]);
  });

  it('keeps the last value on failure (no onLoad), and retry sends the last request again', async () => {
    const { loader, run, answer, settle, requested, onLoad } = setup();
    run('a');
    await answer('a', 'A');

    run('boom');
    await settle();
    expect([loader.value(), loader.loading(), loader.failed()]).toEqual(['A', false, true]);
    expect(onLoad).toHaveBeenCalledExactlyOnceWith('A');

    loader.retry(); // repeats 'boom'
    TestBed.tick();
    await settle();
    expect(requested).toEqual(['a', 'boom', 'boom']);
    expect([loader.value(), loader.failed()]).toEqual(['A', true]);

    run('c'); // still alive after a failure
    expect([loader.loading(), loader.failed()]).toEqual([true, false]);
    await answer('c', 'C');
    expect([loader.value(), loader.failed()]).toEqual(['C', false]);
  });
});
