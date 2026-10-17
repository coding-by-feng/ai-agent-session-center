// Found on a real iPhone (Oct 2026): under windows-xp the phone's "Search this chat" field was a white,
// square, bordered box sticking out of its grey pill. The theme's form-field rule targets every
// input on <body> and beats the phone kit's one-class rules; the phone has its own palette per theme.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const xp = readFileSync(resolve(process.cwd(), 'src/styles/themes/windows-xp.css'), 'utf8');
const chat = readFileSync(resolve(process.cwd(), 'src/styles/modules/mobile/Chat.module.css'), 'utf8');

describe('phone fields under the desktop windows-xp theme', () => {
  it('leaves the phone app out of the theme\'s form-field rules', () => {
    const fieldSelectors = xp.split('\n').filter((l) => /^body\[data-theme="windows-xp"\][^{]*\b(input|textarea|select)\b/.test(l));
    expect(fieldSelectors.length).toBeGreaterThan(0);
    for (const sel of fieldSelectors) expect(sel, sel).toContain(':not(.phoneApp)');
  });

  it('keeps the chat search input inside its pill', () => {
    const rule = chat.match(/\.searchInput \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/height:\s*100%/);
  });
});
