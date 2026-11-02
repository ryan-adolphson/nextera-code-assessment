import { DecimalPipe } from '@angular/common';
import { Component, input } from '@angular/core';
import { FarmTabs } from './farm-tabs';
import { FarmSummary } from './fleet.store';

/**
 * A farm page's header (name, id, location) and its tabs (Overview, History, Weather history); the
 * page's content goes inside (`<app-farm-header [farm]="farm">…</app-farm-header>`) and is
 * projected into the tab panel.
 */
@Component({
  selector: 'app-farm-header',
  imports: [DecimalPipe, FarmTabs],
  host: { class: 'block' },
  template: `
    <h1 class="mt-3 text-3xl font-bold">
      {{ farm().name }} <span class="text-muted">{{ farm().id }}</span>
    </h1>
    <p class="text-sm text-muted">
      {{ farm().latitude | number: '1.2-2' }}, {{ farm().longitude | number: '1.2-2' }}
    </p>
    <app-farm-tabs [farmId]="farm().id"><ng-content /></app-farm-tabs>
  `,
})
export class FarmHeader {
  readonly farm = input.required<FarmSummary>();
}
