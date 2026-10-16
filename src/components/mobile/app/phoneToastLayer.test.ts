// Toasts carry the Mac's refusals ("Choose a folder inside your home folder…"), and most of them
// are raised from a sheet. Found on a real iPhone (Oct 2026): the toast layer sat at z-index 300
// under the sheet's 10030, so every refusal from New session was invisible.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8');
const token = (css: string, name: string): number => {
  const m = css.match(new RegExp(`--${name}:\\s*(\\d+)`));
  if (!m) throw new Error(`no --${name}`);
  return Number(m[1]);
};

describe('the phone toast layer', () => {
  const tokens = read('src/styles/modules/mobile/phoneTokens.css');
  const frame = read('src/styles/modules/mobile/PhoneAppFrame.module.css');

  it('sits above sheets and menus', () => {
    const toast = token(tokens, 'ph-z-toast');
    expect(toast).toBeGreaterThan(token(tokens, 'ph-z-sheet'));
    expect(toast).toBeGreaterThan(token(tokens, 'ph-z-menu'));
  });

  it('is what the frame gives its toast stack', () => {
    const rule = frame.match(/\.frame \.toasts \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/z-index:\s*var\(--ph-z-toast\)/);
  });
});
