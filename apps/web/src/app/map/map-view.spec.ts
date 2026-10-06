import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LegendItem, MapMarker, MapView } from './map-view';

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
});
