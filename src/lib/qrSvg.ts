// qrSvg.ts — turn text into an SVG path for a QR code (phone pairing, AASC-15).
//
// Wraps the vendored Nayuki encoder. Returns the module grid as one path of
// 1×1 squares so a component can render it with `<svg viewBox>` at any size,
// in the theme's colours, with no canvas and no external request.
import { qrcodegen } from './vendor/qrcodegen';

export interface QrSvg {
  /** Modules per side, including the quiet zone. */
  size: number;
  /** SVG path data: one `M x y h1v1h-1z` square per dark module. */
  path: string;
}

/** Quiet zone (light border) in modules; the QR spec asks for 4. */
const QUIET_ZONE = 4;

export function qrSvg(text: string): QrSvg {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const parts: string[] = [];
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) parts.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
    }
  }
  return { size: qr.size + QUIET_ZONE * 2, path: parts.join('') };
}
