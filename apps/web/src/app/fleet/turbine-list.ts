import { Component, inject } from '@angular/core';
import { FleetStore } from './fleet.store';
import { TurbineTable } from './turbine-table';

/**
 * /turbines: every turbine of every farm with its status and latest reading, live (FleetStore),
 * in the shared `TurbineTable`: sortable by any column (default: turbine id), filterable by text
 * (turbine id, farm id or name), status and commissioning.
 */
@Component({
  selector: 'app-turbine-list',
  // A column filling the shell's window-high page (route data `fillViewport`): heading and filters
  // keep their height, the table frame takes what is left and scrolls its rows.
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  imports: [TurbineTable],
  template: `
    <h1 class="text-3xl font-bold">Turbines</h1>
    <p class="mt-1 text-sm text-muted">
      Every turbine in the fleet with its status and latest reading, live.
    </p>

    @if (store.turbines().length === 0) {
      <p class="mt-6 text-muted" data-testid="no-turbines">No turbines are registered yet.</p>
    } @else {
      <app-turbine-table [turbines]="store.turbines()" />
    }
  `,
})
export class TurbineList {
  protected readonly store = inject(FleetStore);
}
