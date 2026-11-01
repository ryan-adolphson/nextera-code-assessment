import { Component, computed, inject } from '@angular/core';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { FleetStore } from '../fleet/fleet.store';
import { TimeZoneMode, TimeZoneSettings, formatIn, offsetLabel } from '../core/time-zone';

/**
 * /settings (every role): how times are shown, UTC (default) or the browser's time zone. Saved in
 * this browser for the signed-in user; every page follows a change at once (signals).
 */
@Component({
  selector: 'app-settings-page',
  imports: [MatButtonToggle, MatButtonToggleGroup],
  template: `
    <h1 class="text-3xl font-bold">Settings</h1>

    <section class="mt-6 grid max-w-xl gap-3" aria-labelledby="time-zone-heading">
      <h2 id="time-zone-heading" class="text-lg font-semibold">Time zone</h2>
      <p class="text-sm text-muted">
        How dates and times are shown on every page, in charts and in date pickers. CSV downloads
        always use UTC timestamps.
      </p>
      <!-- One choice of two: a Material toggle group (role=radiogroup, aria-checked). -->
      <mat-button-toggle-group
        hideSingleSelectionIndicator
        aria-labelledby="time-zone-heading"
        class="justify-self-start"
        data-testid="time-zone"
        [value]="settings.mode()"
        (change)="choose($event.value)"
      >
        <mat-button-toggle value="utc" data-testid="time-zone-utc">UTC</mat-button-toggle>
        <mat-button-toggle value="local" data-testid="time-zone-local">{{
          localLabel()
        }}</mat-button-toggle>
      </mat-button-toggle-group>
      <p class="text-sm" data-testid="time-zone-preview">
        Now: <span class="font-semibold" data-testid="time-zone-now">{{ preview() }}</span>
      </p>
      <p class="text-sm text-muted" data-testid="time-zone-note">Saved in this browser.</p>
    </section>
  `,
})
export class SettingsPage {
  protected readonly settings = inject(TimeZoneSettings);
  /** The clock, ticking every minute (FleetStore), for the preview. */
  private readonly now = inject(FleetStore).now;

  /** "Local (America/Chicago, UTC−5)": the browser's zone and its offset now. */
  protected readonly localLabel = computed(() => {
    const zone = this.settings.browserZone;
    return `Local (${zone}, ${offsetLabel(zone, this.now())})`;
  });

  /** "Oct 31, 14:05 UTC", or "Oct 31, 09:05 CDT" in local time. */
  protected readonly preview = computed(() =>
    formatIn(this.now(), 'MMM d, HH:mm', this.settings.zone(), true),
  );

  protected choose(mode: TimeZoneMode): void {
    this.settings.setMode(mode === 'local' ? 'local' : 'utc');
  }
}
