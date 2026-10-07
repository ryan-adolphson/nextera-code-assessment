import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TableFrame } from './table-frame';

@Component({
  imports: [TableFrame],
  template: `
    <app-table-frame label="Turbines" testId="frame" scrollTestId="scroll">
      <p>not projected: only a table and a footer are</p>
      <table data-testid="table"></table>
      <nav table-footer data-testid="footer">1 – 1 of 1</nav>
    </app-table-frame>
  `,
})
class Host {}

describe('TableFrame', () => {
  const render = () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('is a bordered column that keeps the footer out of the scrolling region', () => {
    const el = render();
    const frame = el.querySelector<HTMLElement>('[data-testid=frame]')!;
    for (const c of ['flex', 'flex-col', 'min-h-48', 'overflow-hidden', 'border']) {
      expect(frame.classList).toContain(c);
    }
    const region = el.querySelector<HTMLElement>('[data-testid=scroll]')!;
    expect([region.getAttribute('role'), region.getAttribute('aria-label')]).toEqual([
      'region',
      'Turbines',
    ]);
    expect(region.tabIndex).toBe(0); // keyboard users can scroll it
    expect(region.classList).toContain('overflow-auto');
    expect(region.contains(el.querySelector('[data-testid=table]'))).toBe(true);

    const footer = el.querySelector('[data-testid=footer]')!;
    expect(region.contains(footer)).toBe(false);
    expect(footer.parentElement).toBe(frame); // a direct child: styled by the frame
    expect(el.textContent).not.toContain('not projected');
  });
});
