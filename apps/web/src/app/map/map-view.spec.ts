import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import * as L from 'leaflet';
import { CLUSTER_FROM, LegendItem, MapMarker, MapView } from './map-view';

@Component({
  imports: [MapView],
  template: `<app-map-view
    [markers]="markers()"
    [selectedId]="selected()"
    [legend]="legend"
    (markerClick)="clicked.push($event)"
  />`,
})
class Host {
  readonly markers = signal<MapMarker[]>([]);
  readonly selected = signal<string | null>(null);
  readonly legend: LegendItem[] = [{ status: 'ok', label: 'Reporting' }];
  readonly clicked: string[] = [];
}

const marker = (id: string, overrides: Partial<MapMarker> = {}): MapMarker => ({
  id,
  lat: 41.25,
  lng: -96.53,
  status: 'ok',
  tooltip: [id, 'detail'],
  ...overrides,
});

describe('MapView (Leaflet)', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    await fixture.whenStable();
  });

  const render = async (markers: MapMarker[], selected: string | null = null) => {
    host.markers.set(markers);
    host.selected.set(selected);
    await fixture.whenStable();
  };
  const markerEl = (id: string) => el.querySelector<SVGPathElement>(`[data-marker-id="${id}"]`);

  it('creates a Leaflet map with OpenStreetMap attribution', () => {
    expect(el.querySelector('.leaflet-container')).not.toBeNull();
    expect(el.querySelector('.leaflet-control-attribution')?.textContent).toContain(
      'OpenStreetMap',
    );
  });

  it('draws one vector marker per item, classed by status and selection', async () => {
    await render(
      [
        marker('A'),
        marker('B', { lat: 39.75, lng: -101.22, status: 'stale-30' }),
        marker('C', { status: 'empty' }),
      ],
      'B',
    );

    expect(el.querySelectorAll('.map-marker')).toHaveLength(3);
    expect(markerEl('A')!.classList).toContain('marker-ok');
    expect(markerEl('B')!.classList).toContain('marker-stale-30');
    expect(markerEl('B')!.classList).toContain('marker-selected');
    expect(markerEl('C')!.classList).toContain('marker-empty');
  });

  it('emits the marker id on click', async () => {
    await render([marker('FARM01')]);

    markerEl('FARM01')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(host.clicked).toEqual(['FARM01']);
  });

  it('renders tooltips as text, never as HTML', async () => {
    await render([marker('X', { tooltip: ['<img src=x onerror=alert(1)>', 'line 2'] })]);

    markerEl('X')!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await fixture.whenStable();

    const tooltip = document.querySelector('.leaflet-tooltip');
    expect(tooltip?.querySelector('img')).toBeNull();
    expect(tooltip?.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('keeps the view when markers update (live data) but re-fits when the set changes', async () => {
    await render([marker('A'), marker('B', { lat: 39.75, lng: -101.22 })]);
    const map = () => (fixture.debugElement.children[0].componentInstance as MapView)['map']!;

    map().setView([30, -90], 5); // the user pans away
    await render([marker('A', { status: 'stale-60' }), marker('B', { lat: 39.75, lng: -101.22 })]);
    expect(map().getCenter()).toEqual({ lat: 30, lng: -90 });

    await render([marker('A'), marker('B', { lat: 39.75, lng: -101.22 })]); // same set again
    expect(map().getCenter()).toEqual({ lat: 30, lng: -90 });

    await render([marker('C', { lat: 35.12, lng: -106.55 })]); // a different set
    expect(map().getCenter()).not.toEqual({ lat: 30, lng: -90 });
  });

  it('shows the legend', () => {
    expect(el.querySelector('[data-testid=legend]')?.textContent).toContain('Reporting');
    expect(el.querySelector('[data-testid=legend] li')?.getAttribute('data-status')).toBe('ok');
  });

  it('colours markers green, yellow, orange, red and grey from the theme tokens', async () => {
    const tokens = {
      '--ok': '#2b8a3e',
      '--caution': '#fcc419',
      '--warn': '#e67700',
      '--danger': '#c92a2a',
      '--muted': '#6b6b6b',
    };
    const root = document.documentElement.style;
    for (const [name, value] of Object.entries(tokens)) root.setProperty(name, value);
    try {
      const statuses = ['ok', 'stale-15', 'stale-30', 'stale-60', 'empty'] as const;
      await render(statuses.map((status) => marker(status, { status })));

      expect(statuses.map((s) => markerEl(s)!.getAttribute('fill'))).toEqual([
        '#2b8a3e',
        '#fcc419',
        '#e67700',
        '#c92a2a',
        '#6b6b6b',
      ]);
    } finally {
      for (const name of Object.keys(tokens)) root.removeProperty(name);
    }
  });

  describe('clustering', () => {
    const many = (count: number, status: MapMarker['status'] = 'ok') =>
      Array.from({ length: count }, (_, i) =>
        marker(`T${i}`, {
          lat: 41 + (i % 10) * 0.0001,
          lng: -96 + Math.floor(i / 10) * 0.0001,
          status,
        }),
      );

    it('groups nearby markers from CLUSTER_FROM on, with the legend entry and a named cluster', async () => {
      await render([...many(CLUSTER_FROM - 1), marker('RED', { status: 'stale-60' })]);

      // jsdom has no layout (a 0 x 0 map draws no cluster), so ask the group for its icon.
      const view = fixture.debugElement.children[0].componentInstance as MapView;
      const group = view['markerLayer'] as L.MarkerClusterGroup;
      expect(group).toBeInstanceOf(L.MarkerClusterGroup);
      expect(group.getLayers()).toHaveLength(CLUSTER_FROM);
      const icon = (group.options as L.MarkerClusterGroupOptions).iconCreateFunction!({
        getAllChildMarkers: () => group.getLayers(),
      } as L.MarkerCluster) as L.DivIcon;
      const html = icon.options.html as HTMLElement;
      expect(icon.options.className).toBe('map-cluster map-cluster-stale-60'); // the most severe inside
      expect(html.textContent).toContain(`${CLUSTER_FROM}`);
      expect(html.querySelector('.sr-only')!.textContent).toContain('most severe status');
      expect(el.querySelector('[data-testid=legend-cluster]')).not.toBeNull();
      expect(el.querySelector('#map-help')!.textContent).toContain('grouped into clusters');
    });

    /** The icon the group would draw for a cluster holding `children` (jsdom draws none). */
    const iconFor = (children: L.Layer[]) => {
      const view = fixture.debugElement.children[0].componentInstance as MapView;
      const group = view['markerLayer'] as L.MarkerClusterGroup;
      const create = (group.options as L.MarkerClusterGroupOptions).iconCreateFunction!;
      return create({ getAllChildMarkers: () => children } as L.MarkerCluster) as L.DivIcon;
    };
    const layers = () =>
      (
        (fixture.debugElement.children[0].componentInstance as MapView)[
          'markerLayer'
        ] as L.MarkerClusterGroup
      ).getLayers();

    it.each([
      [9, 34],
      [10, 40],
      [99, 40],
      [100, 46],
    ])('sizes a cluster of %i markers at %i px', async (count, size) => {
      await render(many(CLUSTER_FROM));
      const [first] = layers();

      const icon = iconFor(Array.from({ length: count }, () => first));

      expect((icon.options.iconSize as L.Point).x).toBe(size);
      expect((icon.options.html as HTMLElement).textContent).toContain(`Group of ${count} `);
    });

    it('takes the most severe status inside: 60 min over 30 over 15 over reporting', async () => {
      await render([
        ...many(CLUSTER_FROM - 3),
        marker('S15', { status: 'stale-15' }),
        marker('S30', { status: 'stale-30' }),
        marker('S60', { status: 'stale-60' }),
      ]);
      /** The layers drawn with `status` (the circle's class carries it). */
      const withStatus = (status: string) =>
        layers().filter((l) =>
          (l as L.Path).options.className?.split(' ').includes(`marker-${status}`),
        );
      const [ok, s15, s30, s60] = ['ok', 'stale-15', 'stale-30', 'stale-60'].map(withStatus);
      const className = (children: L.Layer[]) => iconFor(children).options.className;

      expect(className(ok.slice(0, 2))).toBe('map-cluster map-cluster-ok');
      expect(className([...ok.slice(0, 2), ...s15])).toBe('map-cluster map-cluster-stale-15');
      expect(className([...ok.slice(0, 2), ...s15, ...s30])).toBe(
        'map-cluster map-cluster-stale-30',
      );
      expect(className([...s30, ...s60, ...ok.slice(0, 2)])).toBe(
        'map-cluster map-cluster-stale-60',
      );
    });

    it('counts a layer it never styled as reporting', async () => {
      await render(many(CLUSTER_FROM));

      const icon = iconFor([L.circleMarker([41, -96])]);

      expect(icon.options.className).toBe('map-cluster map-cluster-ok');
    });

    it('keeps plain circles below CLUSTER_FROM', async () => {
      await render(many(CLUSTER_FROM - 1));

      expect(el.querySelectorAll('.map-marker')).toHaveLength(CLUSTER_FROM - 1);
      expect(el.querySelector('.map-cluster')).toBeNull();
      expect(el.querySelector('[data-testid=legend-cluster]')).toBeNull();
    });
  });
});
