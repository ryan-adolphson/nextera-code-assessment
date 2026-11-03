import { withAlpha } from './chart-theme';

describe('withAlpha', () => {
  it('turns a #rrggbb colour into rgba() with the alpha', () => {
    expect(withAlpha('#2a78d6', 0.25)).toBe('rgba(42, 120, 214, 0.25)');
    expect(withAlpha('#FFFFFF', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it.each(['rgb(1, 2, 3)', '#fff', 'oklch(0.7 0.1 250)', 'red'])(
    'returns %s unchanged (not #rrggbb)',
    (colour) => {
      expect(withAlpha(colour, 0.5)).toBe(colour);
    },
  );
});
