import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import * as L from 'leaflet';
import type { Staleness } from '../fleet/staleness';

/** A marker's state: reporting, one of the three "No data in …" levels, or never reported. */
export type MarkerStatus = Staleness;

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  status: MarkerStatus;
  /** Circle radius in pixels (default 8). */
  radius?: number;
  /** Tooltip lines; the first is shown in bold. Rendered as text, never as HTML. */
  tooltip: string[];
}

export interface LegendItem {
  status: MarkerStatus;
  label: string;
}

/** Marker colours come from the theme (CSS variables), so they follow light/dark mode. */
export const STATUS_COLOR_VAR: Record<MarkerStatus, string> = {
  ok: '--ok',
  'stale-15': '--caution', // yellow
  'stale-30': '--warn', // orange
  'stale-60': '--danger', // red
  empty: '--muted',
};

const CONTIGUOUS_US: L.LatLngTuple = [39.5, -98.35];

/**
 * Leaflet map showing markers as vector circles (no image icons to bundle). Data-driven: pass
 * `markers` and react to `markerClick`. The view only re-fits when the set of markers changes,
 * so live updates recolour markers without moving the map under the user.
 */
@Component({
  selector: 'app-map-view',
  host: { class: 'block' },
  template: `
    <!-- z-0 keeps Leaflet's panes below page overlays. -->
    <div
      #map
      class="relative z-0 h-[var(--map-height,26rem)] rounded-lg border border-line"
      role="region"
      [attr.aria-label]="label()"
    ></div>
    @if (legend().length) {
      <ul class="mt-2 flex flex-wrap gap-4 text-xs text-muted" data-testid="legend">
        @for (item of legend(); track item.status) {
          <li class="group flex items-center gap-1.5" [attr.data-status]="item.status">
            <span
              class="size-2.5 rounded-full bg-muted group-data-[status=ok]:bg-ok group-data-[status=stale-15]:bg-caution group-data-[status=stale-30]:bg-warn group-data-[status=stale-60]:bg-danger"
              aria-hidden="true"
            ></span
            >{{ item.label }}
          </li>
        }
      </ul>
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapView {
  readonly markers = input.required<MapMarker[]>();
  readonly selectedId = input<string | null>(null);
  readonly label = input('Map');
  readonly legend = input<LegendItem[]>([]);
  /** Upper zoom limit when fitting the markers (a single marker would otherwise zoom fully in). */
  readonly maxZoom = input(12);
  readonly markerClick = output<string>();

  private readonly container = viewChild.required<ElementRef<HTMLElement>>('map');
  private readonly ready = signal(false);
  private readonly markerLayer = L.layerGroup();
  private map?: L.Map;
  private fittedKey = '';

  constructor() {
    afterNextRender(() => {
      this.map = L.map(this.container().nativeElement, {
        scrollWheelZoom: false, // don't hijack page scrolling
        worldCopyJump: true,
      }).setView(CONTIGUOUS_US, 4);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.map);
      this.markerLayer.addTo(this.map);
      this.ready.set(true);
    });

    effect(() => {
      if (this.ready()) this.render(this.markers(), this.selectedId());
    });

    inject(DestroyRef).onDestroy(() => this.map?.remove());
  }

  private render(markers: MapMarker[], selectedId: string | null): void {
    const theme = getComputedStyle(document.documentElement);
    const color = (name: string) => theme.getPropertyValue(name).trim() || '#888';

    this.markerLayer.clearLayers();
    for (const marker of markers) {
      const fill = color(STATUS_COLOR_VAR[marker.status]);
      const selected = marker.id === selectedId;
      L.circleMarker([marker.lat, marker.lng], {
        radius: marker.radius ?? 8,
        color: selected ? color('--accent') : fill,
        weight: selected ? 4 : 2,
        fillColor: fill,
        fillOpacity: 0.75,
        className: `map-marker marker-${marker.status}${selected ? ' marker-selected' : ''}`,
      })
        .bindTooltip(tooltipElement(marker.tooltip), { direction: 'top' })
        .on('click', () => this.markerClick.emit(marker.id))
        .addTo(this.markerLayer)
        .getElement()
        ?.setAttribute('data-marker-id', marker.id);
    }

    // Fit only when the set of markers changes (first render, another farm), not on live updates.
    const key = markers.map((m) => m.id).join('|');
    if (markers.length && key !== this.fittedKey) {
      this.fittedKey = key;
      this.map!.fitBounds(L.latLngBounds(markers.map((m) => [m.lat, m.lng])), {
        padding: [40, 40],
        maxZoom: this.maxZoom(),
      });
    }
  }
}

/** Builds tooltip content with textContent, so names and IDs can never inject HTML. */
function tooltipElement(lines: string[]): HTMLElement {
  const root = document.createElement('div');
  lines.forEach((line, i) => {
    const el = document.createElement(i === 0 ? 'strong' : 'div');
    el.textContent = line;
    root.append(el);
  });
  return root;
}
