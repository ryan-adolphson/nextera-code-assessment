import { TestBed } from '@angular/core/testing';
import { MatIconRegistry } from '@angular/material/icon';
import { firstValueFrom } from 'rxjs';
import { ICONS, provideIcons } from './icons';

describe('provideIcons', () => {
  it('registers every icon as an inline Material Symbol SVG', async () => {
    TestBed.configureTestingModule({ providers: [provideIcons()] });
    const registry = TestBed.inject(MatIconRegistry);
    expect(Object.keys(ICONS).sort()).toEqual([
      'bar-chart',
      'check',
      'chevron-right',
      'close',
      'map',
      'menu',
      'notifications',
      'wind-power',
    ]);
    for (const name of Object.keys(ICONS)) {
      const svg = await firstValueFrom(registry.getNamedSvgIcon(name));
      expect(svg.tagName.toLowerCase()).toBe('svg');
      expect(svg.getAttribute('viewBox')).toBe('0 -960 960 960');
      expect(svg.querySelector('path')).not.toBeNull();
    }
  });
});
