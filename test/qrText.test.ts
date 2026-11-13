import { describe, it, expect } from 'vitest';
import { qrText, QR_TEXT_QUIET_ZONE } from '../src/lib/qrText.js';
import { qrcodegen } from '../src/lib/vendor/qrcodegen.js';

const LINK = 'https://aasc.work/pair#v=2&name=vps&ts=100.101.102.103&p=3333&mc=ABCDEFGH23';

/** Read the half-blocks back into a module grid: true = a filled half-cell. */
function decodeHalfBlocks(text: string): boolean[][] {
  const rows: boolean[][] = [];
  for (const line of text.split('\n')) {
    const top: boolean[] = [];
    const bottom: boolean[] = [];
    for (const ch of line) {
      if (ch === '█') { top.push(true); bottom.push(true); }
      else if (ch === '▀') { top.push(true); bottom.push(false); }
      else if (ch === '▄') { top.push(false); bottom.push(true); }
      else if (ch === ' ') { top.push(false); bottom.push(false); }
      else throw new Error(`unexpected character ${JSON.stringify(ch)}`);
    }
    rows.push(top, bottom);
  }
  return rows;
}

/** The encoder's own grid for `text`, quiet zone included, padded to an even height. */
function expectedGrid(text: string): boolean[][] {
  const qr = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM);
  const size = qr.size + QR_TEXT_QUIET_ZONE * 2;
  const height = size % 2 === 0 ? size : size + 1;
  const grid: boolean[][] = [];
  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];
    for (let x = 0; x < size; x++) {
      const mx = x - QR_TEXT_QUIET_ZONE;
      const my = y - QR_TEXT_QUIET_ZONE;
      row.push(mx >= 0 && my >= 0 && mx < qr.size && my < qr.size && qr.getModule(mx, my));
    }
    grid.push(row);
  }
  return grid;
}

describe('qrText', () => {
  it('draws two module rows per line and decodes back to the encoder’s grid', () => {
    const text = qrText(LINK);
    const grid = decodeHalfBlocks(text);
    expect(grid).toEqual(expectedGrid(LINK));
  });

  it('keeps a 2-module quiet zone of light modules on every side', () => {
    expect(QR_TEXT_QUIET_ZONE).toBe(2);
    const grid = decodeHalfBlocks(qrText(LINK));
    const qr = qrcodegen.QrCode.encodeText(LINK, qrcodegen.QrCode.Ecc.MEDIUM);
    const size = qr.size + 4;
    for (let i = 0; i < 2; i++) {
      expect(grid[i].every((m) => !m)).toBe(true);
      expect(grid[size - 1 - i].every((m) => !m)).toBe(true);
      expect(grid.every((row) => !row[i] && !row[size - 1 - i])).toBe(true);
    }
  });

  it('gives every line the same width, so --invert has no ragged edge', () => {
    const lines = qrText(LINK, { invert: true }).split('\n');
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });

  it('--invert fills exactly the light modules instead', () => {
    const plain = decodeHalfBlocks(qrText(LINK));
    const inverted = decodeHalfBlocks(qrText(LINK, { invert: true }));
    expect(inverted).toEqual(plain.map((row) => row.map((m) => !m)));
  });

  it('encodes different text differently', () => {
    expect(qrText('a')).not.toBe(qrText('b'));
  });
});
