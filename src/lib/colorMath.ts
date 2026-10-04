/**
 * Pure colour maths: hex parsing, HSL, and CIELAB distance.
 *
 * Import-free, so 2D and 3D code (and tests) can share it. Whether a paint READS against what it is
 * painted on is a question of colour distance, not just luminance: peach on lime has the same luminance
 * and is unmistakable, so the diorama's paint rules are judged on `deltaE`.
 */

/** A colour as red, green, blue, each 0..255. */
export type RGB = readonly [number, number, number];

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (alpha ignored) as RGB, or null for anything else. */
export function parseHex(hex: string): RGB | null {
  const match = HEX.exec(hex.trim());
  if (!match) return null;
  const body = match[1].length <= 4 ? [...match[1]].map((c) => c + c).join('') : match[1];
  return [parseInt(body.slice(0, 2), 16), parseInt(body.slice(2, 4), 16), parseInt(body.slice(4, 6), 16)];
}

/** RGB as lowercase `#rrggbb`, each channel rounded and clamped to 0..255. */
export function toHex([r, g, b]: RGB): string {
  const channel = (c: number) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** RGB to hue (0..360), saturation (0..1) and lightness (0..1). */
export function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}

/** Hue (0..360), saturation and lightness (0..1) to RGB (0..255, not rounded). */
export function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

const linear = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** sRGB to CIELAB (D65). */
function toLab([r, g, b]: RGB): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Colour distance between two hex colours (CIE76: Euclidean in CIELAB). Roughly: 2 is just noticeable,
 * 10-20 is a clear difference, 30+ is unmistakable on a thin line. Zero when either colour cannot be
 * parsed — a junk value never claims to be "far from" anything.
 */
export function deltaE(a: string, b: string): number {
  const [ra, rb] = [parseHex(a), parseHex(b)];
  if (!ra || !rb) return 0;
  const [la, lb] = [toLab(ra), toLab(rb)];
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}
