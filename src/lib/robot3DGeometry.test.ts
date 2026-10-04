import { describe, it, expect } from 'vitest';
import { CLAY_PAINT, type ClayTone } from './dioramaLighting';
import { clayMaterials } from './robot3DGeometry';

const TONES: ClayTone[] = ['standard', 'deep'];

describe('clayMaterials', () => {
  // The tone is chosen in one file and painted in another; this is the join. Without it a swapped
  // `body` / `shade`, or a `deep` pair built from the standard colours, would compile and pass every other test.
  it.each(TONES)('paints the %s tone in that tone’s own colours', (tone) => {
    const { body, shade } = clayMaterials(tone);
    expect(`#${body.color.getHexString()}`).toBe(CLAY_PAINT[tone].body);
    expect(`#${shade.color.getHexString()}`).toBe(CLAY_PAINT[tone].shade);
  });

  it('shares one pair per tone, so nothing is built per robot', () => {
    for (const tone of TONES) {
      expect(clayMaterials(tone)).toBe(clayMaterials(tone));
      expect(clayMaterials(tone).body).not.toBe(clayMaterials(tone).shade);
    }
  });

  it('keeps the tones apart: no material is shared between them', () => {
    const [standard, deep] = TONES.map(clayMaterials);
    expect(deep.body).not.toBe(standard.body);
    expect(deep.shade).not.toBe(standard.shade);
  });
});
