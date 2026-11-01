/** Chart colours from the app's CSS variables (light/dark), applied by `themeOption`. */

/** Severity of a marker (the alert levels); worst first. */
export type MarkerLevel = 'error' | 'warn' | 'info';

/** Theme colours, read from the app's CSS variables (re-read when light/dark mode changes). */
export interface ChartTheme {
  series: string;
  grid: string;
  text: string;
  muted: string;
  surface: string;
  /** Marker colours: the status tokens AlertLevelBadge uses (validated for light and dark). */
  levels: Record<MarkerLevel, string>;
}

/** Reads the theme from the CSS variables (call again when the colour scheme changes). */
export function readTheme(): ChartTheme {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    series: get('--series-1', '#2a78d6'),
    grid: get('--border', '#e3e3e8'),
    text: get('--text', '#1a1a1a'),
    muted: get('--muted', '#6b6b6b'),
    surface: get('--bg', '#ffffff'),
    levels: {
      error: get('--danger', '#c92a2a'),
      warn: get('--warn', '#e67700'),
      info: get('--accent', '#3b5bdb'),
    },
  };
}

/** `#rrggbb` + alpha as `rgba()` (other colour formats are returned unchanged). */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!hex) return color;
  const [r, g, b] = hex.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
