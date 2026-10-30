import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { latestLoad } from '../ui/latest-load';
import { TABLE_IMPORTS } from '../ui/table';
import { UnallocatedApi } from './unallocated-api.service';
import { HeldReading, UnallocatedTurbine, utcTime } from './unallocated.model';

/** How many held readings an expanded row shows (two hours of 5-minute readings). */
export const HELD_READINGS_SHOWN = 24;

/**
 * An expanded Pending row: the entry's newest held readings (GET …/:id/readings?limit=24), in a
 * small table. Loads when shown, and again when the entry's held count or last-seen time change
 * (a reload of the list after new readings were held).
 */
@Component({
  selector: 'app-held-readings',
  imports: [DecimalPipe, MatButton, TABLE_IMPORTS],
  template: `
    @if (load.failed()) {
      <p
        class="m-0 flex flex-wrap items-center gap-3 py-2 text-danger"
        role="alert"
        data-testid="held-readings-error"
      >
        Could not load the held readings.
        <button matButton="outlined" type="button" (click)="load.retry()">Retry</button>
      </p>
    } @else if (readings() === null) {
      <p class="m-0 py-2 text-muted" data-testid="held-readings-loading">Loading readings…</p>
    } @else {
      <p class="m-0 pt-2 text-sm text-muted" data-testid="held-readings-count">
        {{ caption() }}
      </p>
      <table
        mat-table
        class="mt-1"
        data-testid="held-readings"
        [dataSource]="readings()!"
        [trackBy]="trackByTime"
        [attr.aria-label]="'Held readings for ' + entry().turbineId"
      >
        <ng-container matColumnDef="timestamp">
          <th mat-header-cell *matHeaderCellDef>Measured (UTC)</th>
          <td mat-cell *matCellDef="let r" class="tabular-nums">{{ time(r.timestamp) }}</td>
        </ng-container>
        <ng-container matColumnDef="receivedAt">
          <th mat-header-cell *matHeaderCellDef>Received (UTC)</th>
          <td mat-cell *matCellDef="let r" class="tabular-nums">{{ time(r.receivedAt) }}</td>
        </ng-container>
        <ng-container matColumnDef="farmId">
          <th mat-header-cell *matHeaderCellDef>Reported farm</th>
          <td mat-cell *matCellDef="let r">{{ r.farmId }}</td>
        </ng-container>
        @for (m of metrics; track m.key) {
          <ng-container [matColumnDef]="m.key">
            <th mat-header-cell *matHeaderCellDef class="text-right!">{{ m.label }}</th>
            <td mat-cell *matCellDef="let r" class="text-right! tabular-nums">
              {{ r[m.key] | number: '1.0-1' }}
            </td>
          </ng-container>
        }
        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let r; columns: columns" data-testid="held-reading"></tr>
      </table>
    }
  `,
})
export class HeldReadings {
  private readonly api = inject(UnallocatedApi);
  readonly entry = input.required<UnallocatedTurbine>();

  protected readonly load = latestLoad((id: string) => this.api.readings(id, HELD_READINGS_SHOWN));
  protected readonly readings = this.load.value;
  protected readonly caption = computed(() => {
    const shown = this.readings()?.length ?? 0;
    const held = this.entry().heldCount;
    return shown < held
      ? `The newest ${shown} of ${held} held readings, newest first.`
      : `${held} held ${held === 1 ? 'reading' : 'readings'}, newest first.`;
  });
  protected readonly metrics = [
    { key: 'powerOutputKw', label: 'Power (kW)' },
    { key: 'windSpeedMs', label: 'Wind (m/s)' },
    { key: 'rotorRpm', label: 'Rotor (rpm)' },
    { key: 'bladePitchDeg', label: 'Pitch (°)' },
    { key: 'gearboxTempC', label: 'Gearbox (°C)' },
  ] as const;
  protected readonly columns = [
    'timestamp',
    'receivedAt',
    'farmId',
    ...this.metrics.map((m) => m.key),
  ];
  protected readonly time = utcTime;
  protected readonly trackByTime = (_: number, r: HeldReading) => r.timestamp;

  /** Changes when there is something new to load (not on every reload of the same list). */
  private readonly loadKey = computed(() => {
    const { id, heldCount, lastSeenAt } = this.entry();
    return `${id} ${heldCount} ${lastSeenAt}`;
  });

  constructor() {
    effect(() => {
      this.loadKey();
      untracked(() => this.load.run(this.entry().id));
    });
  }
}
