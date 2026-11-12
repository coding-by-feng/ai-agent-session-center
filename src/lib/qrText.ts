// qrText.ts — a QR code drawn in a terminal with half-block characters (terminal editions, P2.2).
//
// Each character covers two module rows: '▀' fills the top one, '▄' the bottom, '█' both
// and ' ' neither. A filled half-cell is drawn in the terminal's foreground colour, so the
// default fills the dark modules: right on a light-background terminal. On a dark one that
// reads as light-on-dark, which some phone cameras scan poorly; `invert` fills the light
// modules (quiet zone included) instead, so the code comes out dark on light there.
//
// Pure: the vendored Nayuki encoder only, the same one qrSvg.ts uses.
import { qrcodegen } from './vendor/qrcodegen.js';

/** Light border in modules. The spec asks for 4; 2 scans fine and keeps the code short in a terminal. */
export const QR_TEXT_QUIET_ZONE = 2;

export interface QrTextOptions {
  /** Fill the light modules instead of the dark ones (for light-on-dark terminals). */
  invert?: boolean;
}

const BLOCKS = [' ', '▄', '▀', '█'] as const;

/** `text` as a QR code, one string of lines joined by '\n', every line the same width. */
export function qrText(text: string, options: QrTextOptions = {}): string {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const size = qr.size + QR_TEXT_QUIET_ZONE * 2;
  const invert = options.invert === true;
  const filled = (x: number, y: number): boolean => {
    const mx = x - QR_TEXT_QUIET_ZONE;
    const my = y - QR_TEXT_QUIET_ZONE;
    const dark = mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.getModule(mx, my);
    return dark !== invert;
  };
  const lines: string[] = [];
  // An odd height leaves the last line's bottom half as one more light row.
  for (let y = 0; y < size; y += 2) {
    let line = '';
    for (let x = 0; x < size; x++) {
      const top = filled(x, y) ? 2 : 0;
      const bottom = filled(x, y + 1 < size ? y + 1 : size) ? 1 : 0;
      line += BLOCKS[top + bottom];
    }
    lines.push(line);
  }
  return lines.join('\n');
}
