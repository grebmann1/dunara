import { expect, it } from 'vitest';
import { designSchema } from '../../core/src/contracts.js';
import { presets, recipes } from './catalog.js';
function luminance(hex: string) {
  const rgb = hex.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return rgb[0]! * .2126 + rgb[1]! * .7152 + rgb[2]! * .0722;
}
it('validates every composed preset and readable foreground pairs', () => {
  for (const [preset, modes] of Object.entries(presets)) for (const [mode, tokens] of Object.entries(modes)) {
    expect(designSchema.safeParse({ preset, mode, tokens }).success).toBe(true);
    for (const [fg, bg] of [[tokens.text, tokens.background], [tokens.muted, tokens.background], [tokens.onAccent, tokens.accent]]) {
      const a = luminance(fg!), b = luminance(bg!);
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(recipes[0].routes).toHaveLength(3);
});
