import { describe, it, expect } from 'vitest';
import { deltaE, hslToRgb, parseHex, rgbToHsl, toHex } from './colorMath';

describe('parseHex', () => {
  it('reads #rgb and #rrggbb', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#00f0ff')).toEqual([0, 240, 255]);
    expect(parseHex('#0A5FD6')).toEqual([10, 95, 214]);
  });

  it('ignores alpha, in both short and long form', () => {
    expect(parseHex('#00f0ff80')).toEqual([0, 240, 255]);
    expect(parseHex('#0f08')).toEqual([0, 255, 0]);
  });

  it('is null for anything else', () => {
    for (const junk of ['', 'red', 'rgb(1,2,3)', '#12', '#12345', '#gggggg', '00f0ff']) {
      expect(parseHex(junk), junk).toBeNull();
    }
  });
});

describe('toHex', () => {
  it('writes lowercase #rrggbb, padded', () => {
    expect(toHex([0, 240, 255])).toBe('#00f0ff');
    expect(toHex([1, 2, 3])).toBe('#010203');
  });

  it('rounds and clamps', () => {
    expect(toHex([-5, 300, 127.6])).toBe('#00ff80');
  });
});

describe('rgbToHsl / hslToRgb', () => {
  it('knows the primaries and the greys', () => {
    expect(rgbToHsl([255, 0, 0])).toEqual([0, 1, 0.5]);
    const [h, s, l] = rgbToHsl([0, 0, 255]);
    expect(h).toBeCloseTo(240, 6);
    expect(s).toBe(1);
    expect(l).toBe(0.5);
    expect(rgbToHsl([128, 128, 128])[1]).toBe(0);
  });

  it('round-trips any colour to within one level', () => {
    for (const hex of ['#00f0ff', '#ff00aa', '#d97706', '#3b82f6', '#4a7a1e', '#e8ddd0', '#2a354f', '#000000', '#ffffff']) {
      const rgb = parseHex(hex)!;
      const back = hslToRgb(...rgbToHsl(rgb));
      back.forEach((c, i) => expect(Math.abs(c - rgb[i]), hex).toBeLessThanOrEqual(1));
    }
  });
});

describe('deltaE', () => {
  it('is zero between a colour and itself, and symmetric', () => {
    expect(deltaE('#3b82f6', '#3b82f6')).toBe(0);
    expect(deltaE('#3b82f6', '#e8ddd0')).toBeCloseTo(deltaE('#e8ddd0', '#3b82f6'), 9);
  });

  it('puts black and white 100 apart', () => {
    expect(deltaE('#000000', '#ffffff')).toBeCloseTo(100, 0);
  });

  // Reference values, pinned: a change to a Lab coefficient, the white point or the sRGB linearisation moves
  // at least one of these (black and white alone would not: they sit on the lightness axis).
  it('matches CIE76 reference distances from black', () => {
    expect(deltaE('#ff0000', '#000000')).toBeCloseTo(117.345, 2);
    expect(deltaE('#0000ff', '#000000')).toBeCloseTo(137.66, 2);
    expect(deltaE('#808080', '#000000')).toBeCloseTo(53.585, 2);
  });

  it('puts pure red and pure green about 170 apart (CIE76)', () => {
    expect(deltaE('#ff0000', '#00ff00')).toBeGreaterThan(169);
    expect(deltaE('#ff0000', '#00ff00')).toBeLessThan(172);
  });

  it('sees hue, not just brightness: peach and lime of equal luminance are far apart', () => {
    expect(deltaE('#ffc095', '#b9dc8c')).toBeGreaterThan(20);
  });

  it('is zero for a colour it cannot parse, rather than throwing', () => {
    expect(deltaE('red', '#ffffff')).toBe(0);
  });
});
