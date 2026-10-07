import { Injector, runInInjectionContext } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, throwError } from 'rxjs';
import { latestLoad } from './latest-load';

describe('latestLoad', () => {
  /** A load whose answers the test controls, one Subject per request. */
  function setup() {
    const pending = new Map<string, Subject<string>>();
    const onLoad = vi.fn();
    const loader = runInInjectionContext(TestBed.inject(Injector), () =>
      latestLoad((id: string) => {
        if (id === 'boom') return throwError(() => new Error('500'));
        const answer = new Subject<string>();
        pending.set(id, answer);
        return answer;
      }, onLoad),
    );
    const answer = (id: string, value: string) => {
      pending.get(id)!.next(value);
      pending.get(id)!.complete();
    };
    return { loader, answer, onLoad };
  }

  it('keeps the answer as signals and calls onLoad', () => {
    const { loader, answer, onLoad } = setup();
    expect([loader.value(), loader.loading(), loader.failed()]).toEqual([null, false, false]);

    loader.run('a');
    expect(loader.loading()).toBe(true);
    answer('a', 'A');
    expect([loader.value(), loader.loading(), loader.failed()]).toEqual(['A', false, false]);
    expect(onLoad).toHaveBeenCalledExactlyOnceWith('A');
  });

  it('drops the answer to an older request (only the latest counts)', () => {
    const { loader, answer } = setup();
    loader.run('a');
    loader.run('b');
    answer('a', 'A'); // too late: 'a' was cancelled by 'b'
    expect(loader.value()).toBeNull();
    answer('b', 'B');
    expect(loader.value()).toBe('B');
  });

  it('keeps the last value on failure, and retry sends the last request again', () => {
    const { loader, answer } = setup();
    loader.run('a');
    answer('a', 'A');

    loader.run('boom');
    expect([loader.value(), loader.loading(), loader.failed()]).toEqual(['A', false, true]);

    loader.run('c'); // still alive after a failure
    loader.retry(); // repeats 'c'
    answer('c', 'C');
    expect([loader.value(), loader.failed()]).toEqual(['C', false]);
  });
});
