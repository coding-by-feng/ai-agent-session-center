import { describe, it, expect } from 'vitest';
import { CLAY_PAINT, liveryPaint, type ClayTone } from './dioramaLighting';
import { PALETTE } from './robotPalette';
import { clayMaterials, createLiveryMat, liveryMaterials } from './robot3DGeometry';

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

describe('liveryMaterials', () => {
  it.each(TONES)('has one %s material per palette colour, painted in that tone', (tone) => {
    const pool = liveryMaterials(tone);
    expect(pool).toHaveLength(PALETTE.length);
    pool.forEach((material, i) => {
      expect(`#${material.color.getHexString()}`).toBe(liveryPaint(PALETTE[i], tone));
    });
  });

  it('shares one pool per tone, so nothing is built per robot', () => {
    for (const tone of TONES) expect(liveryMaterials(tone)).toBe(liveryMaterials(tone));
    expect(liveryMaterials('deep')[0]).not.toBe(liveryMaterials('standard')[0]);
  });

  // Emissive adds to a lit surface: on a bright rig it is what turns saturated paint into pale ice.
  it('glows less on a bright palette than on a dark one', () => {
    expect(liveryMaterials('deep')[0].emissiveIntensity).toBeLessThan(liveryMaterials('standard')[0].emissiveIntensity);
  });

  it('paints a custom colour the same way a palette colour is painted', () => {
    for (const tone of TONES) {
      const material = createLiveryMat('#12ab34', tone);
      expect(`#${material.color.getHexString()}`).toBe(liveryPaint('#12ab34', tone));
      expect(material.emissiveIntensity).toBe(liveryMaterials(tone)[0].emissiveIntensity);
    }
  });
});
