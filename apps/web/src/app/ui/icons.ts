import { EnvironmentProviders, inject, provideEnvironmentInitializer } from '@angular/core';
import { MatIconRegistry } from '@angular/material/icon';
import { DomSanitizer } from '@angular/platform-browser';
import barChart from '@material-symbols/svg-400/outlined/bar_chart.svg';
import check from '@material-symbols/svg-400/outlined/check.svg';
import close from '@material-symbols/svg-400/outlined/close.svg';
import map from '@material-symbols/svg-400/outlined/map.svg';
import menu from '@material-symbols/svg-400/outlined/menu.svg';
import notifications from '@material-symbols/svg-400/outlined/notifications.svg';
import windPower from '@material-symbols/svg-400/outlined/wind_power.svg';

/**
 * The app's Material Symbols (outlined, weight 400), bundled as SVG markup: no icon font, no
 * HTTP request, and no ligature text in the DOM. Use `<mat-icon svgIcon="<name>" />`.
 */
export const ICONS = {
  'bar-chart': barChart,
  check,
  close,
  map,
  menu,
  notifications,
  'wind-power': windPower,
} as const satisfies Record<string, string>;

export type IconName = keyof typeof ICONS;

/** Registers `ICONS` with `MatIconRegistry` (app config and the component test setup). */
export function provideIcons(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    const registry = inject(MatIconRegistry);
    const sanitizer = inject(DomSanitizer);
    for (const [name, svg] of Object.entries(ICONS)) {
      // Trusted: our own build-time assets, never user input.
      registry.addSvgIconLiteral(name, sanitizer.bypassSecurityTrustHtml(svg));
    }
  });
}
