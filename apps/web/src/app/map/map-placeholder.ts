import { Component, computed, input } from '@angular/core';

/**
 * Stands in for a `MapView` until Leaflet has loaded (`@defer` placeholder, loading and error
 * states): the same height (`--map-height`, default 26rem, set on this host like on the map's) and
 * frame, plus room for the legend, so the page doesn't move when the map replaces it. It imports
 * nothing from Leaflet.
 */
@Component({
  selector: 'app-map-placeholder',
  host: {
    class: 'block',
    '[attr.data-testid]': 'testId()',
    '[attr.data-legend]': "legend() ? '' : null",
  },
  template: `
    <div
      class="grid h-[var(--map-height,26rem)] place-items-center rounded-lg border border-line bg-surface px-4 text-center text-sm text-muted"
      [attr.role]="state() === 'placeholder' ? null : state() === 'error' ? 'alert' : 'status'"
    >
      @switch (state()) {
        @case ('loading') {
          Loading map…
        }
        @case ('error') {
          The map could not be loaded. Reload the page to try again.
        }
      }
    </div>
    @if (legend()) {
      <!-- MapView's legend row: mt-2 + one text-xs line. -->
      <div class="mt-2 h-4" aria-hidden="true"></div>
    }
  `,
})
export class MapPlaceholder {
  readonly state = input<'placeholder' | 'loading' | 'error'>('placeholder');
  /** Whether the map will show a legend (reserves its row). */
  readonly legend = input(true);

  protected readonly testId = computed(() =>
    this.state() === 'error'
      ? 'map-load-error'
      : this.state() === 'loading'
        ? 'map-loading'
        : 'map-placeholder',
  );
}
