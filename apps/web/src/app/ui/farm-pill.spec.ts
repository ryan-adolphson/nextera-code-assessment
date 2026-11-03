import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatChipHarness } from '@angular/material/chips/testing';
import { FarmPill } from './farm-pill';

@Component({
  imports: [FarmPill],
  template: `<div (click)="clicks.set(clicks() + 1)">
    Prairie Ridge <app-farm-pill [farmId]="farmId()" />
  </div>`,
})
class Host {
  readonly farmId = signal('FARM01');
  readonly clicks = signal(0);
}

describe('FarmPill', () => {
  async function open() {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const chip = await TestbedHarnessEnvironment.loader(fixture).getHarness(MatChipHarness);
    return { fixture, chip, root: fixture.nativeElement as HTMLElement };
  }

  it('shows the id in a Material chip, after the name as a separate word', async () => {
    const { fixture, chip, root } = await open();

    expect(await chip.getText()).toBe('FARM01');
    expect(await chip.isDisabled()).toBe(false);
    expect(root.textContent?.replace(/\s+/g, ' ').trim()).toBe('Prairie Ridge FARM01');

    fixture.componentInstance.farmId.set('FARM02');
    await fixture.whenStable();
    expect(await chip.getText()).toBe('FARM02');
  });

  it('is plain text to assistive technology and the keyboard: no roles, tab stop or ripple', async () => {
    const { root } = await open();

    expect(root.querySelector('[role]')).toBeNull();
    expect(root.querySelector('mat-chip-set')).toBeNull();
    expect(root.querySelector('[tabindex], button, a')).toBeNull();
    expect(root.querySelector<HTMLElement>('[data-testid=farm-pill]')!.tabIndex).toBe(-1);
    expect(root.querySelector('.mat-ripple-element')).toBeNull();
  });

  it('lets a click through to what is around it', async () => {
    const { fixture, root } = await open();

    root.querySelector<HTMLElement>('[data-testid=farm-pill]')!.click();

    expect(fixture.componentInstance.clicks()).toBe(1);
  });
});
