import {
  Component,
  DestroyRef,
  computed,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import L from 'leaflet';
// Adds L.markerClusterGroup (the plugin reads Leaflet's global `L`, which Leaflet sets on load; the
// import order matters). Both stay in this component's lazy chunk.
// Import Leaflet as the default, never `import * as L`: the production bundler turns a namespace
// import of this CommonJS module into a COPY of its exports taken before the plugin runs, so the
// copy lacks MarkerClusterGroup/markerClusterGroup. The default is the live object the plugin patches.
import 'leaflet.markercluster';
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

/** From this many markers on, nearby ones are grouped into numbered clusters (fewer: plain circles). */
export const CLUSTER_FROM = 150;

/** Most severe first: the status a cluster takes (the legend names them). */
const SEVERITY: MarkerStatus[] = ['stale-60', 'stale-30', 'stale-15', 'ok', 'empty'];

/**
 * Leaflet map showing markers as vector circles (no image icons to bundle). Data-driven: pass
 * `markers` and react to `markerClick`. The view only re-fits when the set of markers changes,
 * so live updates recolour markers without moving the map under the user.
 *
 * From `CLUSTER_FROM` markers on (10,000 farms, 2,000 turbines) nearby markers are grouped by
 * leaflet.markercluster into numbered rings, drawn only for the visible area. A cluster takes the
 * most severe status inside (ring colour from the same tokens, `.map-cluster` in styles.css),
 * zooms in on Enter or click, and is a focusable button named by its count and status. The circle
 * markers themselves are not focusable: the tables beside the map are the keyboard path to every
 * farm and turbine, which the map's description says.
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
      aria-describedby="map-help"
    ></div>
    <p id="map-help" class="sr-only">
      {{ markers().length }} {{ noun() }} on the map{{
        clustered() ? ', grouped into clusters that zoom in when selected' : ''
      }}. The table lists the same {{ noun() }} for keyboard use.
    </p>
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
        @if (clustered()) {
          <li class="flex items-center gap-1.5" data-testid="legend-cluster">
            <span
              class="grid size-4 place-items-center rounded-full border-2 border-muted bg-page text-[9px] font-semibold text-ink"
              aria-hidden="true"
              >9</span
            >Group of nearby {{ noun() }}, ringed in the most severe status
          </li>
        }
      </ul>
    }
  `,
})
export class MapView {
  readonly markers = input.required<MapMarker[]>();
  readonly selectedId = input<string | null>(null);
  readonly label = input('Map');
  /** What the markers are, for the description and cluster names ("farms", "turbines"). */
  readonly noun = input('markers');
  readonly legend = input<LegendItem[]>([]);
  /** Upper zoom limit when fitting the markers (a single marker would otherwise zoom fully in). */
  readonly maxZoom = input(12);
  readonly markerClick = output<string>();

  private readonly container = viewChild.required<ElementRef<HTMLElement>>('map');
  private readonly ready = signal(false);
  /** Whether the markers are grouped (enough of them). */
  protected readonly clustered = computed(() => this.markers().length >= CLUSTER_FROM);
  private markerLayer: L.FeatureGroup = L.featureGroup();
  private layerClustered = false;
  private readonly statusOf = new WeakMap<L.Layer, MarkerStatus>();
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

  /** The layer for the marker count: a cluster group from `CLUSTER_FROM` markers, else a plain group. */
  private layerFor(clustered: boolean): L.FeatureGroup {
    if (clustered === this.layerClustered) return this.markerLayer;
    this.markerLayer.remove();
    this.layerClustered = clustered;
    this.markerLayer = clustered ? this.clusterGroup() : L.featureGroup();
    this.markerLayer.addTo(this.map!);
    return this.markerLayer;
  }

  private clusterGroup(): L.MarkerClusterGroup {
    const theme = getComputedStyle(document.documentElement);
    const reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return L.markerClusterGroup({
      maxClusterRadius: 50,
      chunkedLoading: true, // 10,000 markers are added in slices, so the page stays responsive
      showCoverageOnHover: false, // the hull polygon has no token colours
      animate: !reduceMotion,
      spiderLegPolylineOptions: {
        weight: 1.5,
        color: theme.getPropertyValue('--muted').trim() || '#888',
        opacity: 0.8,
      },
      iconCreateFunction: (cluster) => this.clusterIcon(cluster),
    });
  }

  /** A ring in the most severe child status with the count; its text names both for screen readers. */
  private clusterIcon(cluster: L.MarkerCluster): L.DivIcon {
    const children = cluster.getAllChildMarkers();
    const statuses = new Set(children.map((c) => this.statusOf.get(c) ?? 'ok'));
    const worst = SEVERITY.find((s) => statuses.has(s)) ?? 'ok';
    const count = children.length;
    const size = count < 10 ? 34 : count < 100 ? 40 : 46;
    const label = this.legend().find((item) => item.status === worst)?.label ?? worst;
    const root = document.createElement('div');
    root.className = 'map-cluster-label';
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = `Group of ${count} ${this.noun()}, most severe status: ${label}. Press Enter to zoom in.`;
    const number = document.createElement('span');
    number.setAttribute('aria-hidden', 'true');
    number.textContent = count.toLocaleString('en-US');
    root.append(sr, number);
    return L.divIcon({
      html: root,
      className: `map-cluster map-cluster-${worst}`,
      iconSize: L.point(size, size),
    });
  }

  private render(markers: MapMarker[], selectedId: string | null): void {
    const theme = getComputedStyle(document.documentElement);
    const color = (name: string) => theme.getPropertyValue(name).trim() || '#888';

    const layer = this.layerFor(markers.length >= CLUSTER_FROM);
    layer.clearLayers();
    const layers = markers.map((marker) => {
      const fill = color(STATUS_COLOR_VAR[marker.status]);
      const selected = marker.id === selectedId;
      const circle = L.circleMarker([marker.lat, marker.lng], {
        radius: marker.radius ?? 8,
        color: selected ? color('--accent') : fill,
        weight: selected ? 4 : 2,
        fillColor: fill,
        fillOpacity: 0.75,
        className: `map-marker marker-${marker.status}${selected ? ' marker-selected' : ''}`,
      })
        .bindTooltip(tooltipElement(marker.tooltip), { direction: 'top' })
        .on('click', () => this.markerClick.emit(marker.id))
        // Clustered markers only get an element while on screen: tag it whenever it is added.
        .on('add', () => circle.getElement()?.setAttribute('data-marker-id', marker.id));
      this.statusOf.set(circle, marker.status);
      return circle;
    });
    if (layer instanceof L.MarkerClusterGroup) layer.addLayers(layers);
    else layers.forEach((l) => l.addTo(layer));

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
