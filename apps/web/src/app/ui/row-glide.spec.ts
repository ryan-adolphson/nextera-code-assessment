import { MediaMatcher } from '@angular/cdk/layout';
import { Component, signal, viewChild } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ROW_GLIDE_MS, RowGlide } from './row-glide';

@Component({
  imports: [RowGlide],
  template: `
    <table appRowGlide>
      <tbody>
        @for (id of ids(); track id) {
          <tr [attr.data-id]="id">
            <td><a href="#">{{ id }}</a></td>
          </tr>
        }
      </tbody>
    </table>
  `,
})
class Host {
  readonly ids = signal(['a', 'b', 'c']);
  readonly glide = viewChild.required(RowGlide);
}

describe('RowGlide', () => {
  const ROW_HEIGHT = 40;
  let reducedMotion: boolean;
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reducedMotion = false;
    animate = vi.fn(() => ({ cancel: vi.fn() }));
    vi.spyOn(HTMLElement.prototype, 'animate').mockImplementation(animate as never);
    // jsdom has no layout: a row's offsetTop follows its place in the DOM.
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return [...this.parentElement!.children].indexOf(this) * ROW_HEIGHT;
    });
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MediaMatcher,
          useValue: { matchMedia: () => ({ get matches() { return reducedMotion; } }) },
        },
      ],
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup() {
    const fixture = TestBed.createComponent(Host);
    document.body.append(fixture.nativeElement);
    await fixture.whenStable();
    const host = fixture.componentInstance;
    const row = (id: string) => fixture.nativeElement.querySelector(`[data-id=${id}]`) as HTMLElement;
    const reorder = async (ids: string[]) => {
      host.glide().reorder(() => host.ids.set(ids));
      await fixture.whenStable();
    };
    return { fixture, host, row, reorder };
  }

  /** Which rows glided, with the offset each started from. */
  const glides = () =>
    animate.mock.contexts.map((row, i) => [
      (row as HTMLElement).getAttribute('data-id'),
      animate.mock.calls[i][0][0].transform,
    ]);

  it('glides each moved row from its old place, for 500 ms, and leaves the others', async () => {
    const { reorder } = await setup();

    await reorder(['c', 'b', 'a']);

    // c moved from row 2 to row 0, a the other way; b stayed.
    expect(Object.fromEntries(glides())).toEqual({
      c: 'translateY(80px)',
      a: 'translateY(-80px)',
    });
    expect(animate.mock.calls[0][0][1]).toEqual({ transform: 'none' });
    expect(animate.mock.calls[0][1]).toMatchObject({ duration: ROW_GLIDE_MS });
    expect(ROW_GLIDE_MS).toBe(500);
  });

  it('lets rows entering the page just appear', async () => {
    const { reorder } = await setup();

    await reorder(['d', 'a', 'b']);

    // a and b moved down one place; c left; d is new.
    expect(glides().map(([id]) => id).sort()).toEqual(['a', 'b']);
  });

  it('does not animate with prefers-reduced-motion, but still applies the change', async () => {
    reducedMotion = true;
    const { reorder, row } = await setup();

    await reorder(['c', 'b', 'a']);

    expect(animate).not.toHaveBeenCalled();
    expect(row('c').previousElementSibling).toBeNull();
  });

  it('does nothing to a change that is not wrapped in reorder()', async () => {
    const { fixture, host } = await setup();

    host.ids.set(['c', 'b', 'a']);
    await fixture.whenStable();

    expect(animate).not.toHaveBeenCalled();
  });

  it('cancels the glides in flight, on cancel() and on the next re-order', async () => {
    const { host, reorder } = await setup();
    await reorder(['c', 'b', 'a']);
    const first = animate.mock.results.map((r) => r.value.cancel);

    host.glide().cancel();
    first.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());

    await reorder(['a', 'b', 'c']);
    const second = animate.mock.results.slice(first.length).map((r) => r.value.cancel);
    await reorder(['b', 'a', 'c']);
    second.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
    first.forEach((cancel) => expect(cancel).toHaveBeenCalledOnce());
  });

  it('keeps the focus on a link in a moved row', async () => {
    const { fixture, host, row, reorder } = await setup();
    const link = row('c').querySelector('a')!;
    link.focus();
    const focus = vi.spyOn(link, 'focus');

    // Moving the row in the DOM blurs what is focused in it, as in a browser.
    host.glide().reorder(() => {
      host.ids.set(['c', 'b', 'a']);
      link.blur();
    });
    await fixture.whenStable();

    expect(document.activeElement).toBe(link);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    await reorder(['a', 'b', 'c']);
    expect(document.activeElement).toBe(link);
  });

  it('leaves the focus alone when it is outside the table or its row left', async () => {
    const outside = document.body.appendChild(document.createElement('button'));
    const { row, reorder } = await setup();
    outside.focus();

    await reorder(['c', 'b', 'a']);
    expect(document.activeElement).toBe(outside);
    outside.remove();

    const link = row('c').querySelector('a')!;
    link.focus();
    const focus = vi.spyOn(link, 'focus');
    await reorder(['a', 'b']); // c is gone
    expect(focus).not.toHaveBeenCalled();
  });

  it('resumes a moved row’s CSS animation on its original timeline', async () => {
    const { host, fixture, row } = await setup();
    const flash = { animationName: 'flash', startTime: 1000 };
    const notStarted = { animationName: 'other', startTime: null };
    const glide = { startTime: 900 }; // a Web Animation, not a CSS one
    vi.spyOn(row('c'), 'getAnimations').mockReturnValue([flash, notStarted, glide] as never);

    const restarted = { animationName: 'flash', startTime: 1500 };
    const fresh = { animationName: 'other', startTime: 1500 };
    host.glide().reorder(() => {
      host.ids.set(['c', 'b', 'a']);
      vi.spyOn(row('c'), 'getAnimations').mockReturnValue([restarted, fresh] as never);
    });
    await fixture.whenStable();

    expect(restarted.startTime).toBe(1000);
    expect(fresh.startTime).toBe(1500); // no earlier run to resume
  });
});
