// Found on a real iPhone (Oct 20 2026): Chat's "Search this chat" bar, once pulled down, stayed
// drawn over Info → Queue pushed on top of it. A screen under the top one is hidden with
// `visibility: hidden`, but a child that says `visibility: visible` shows anyway, and its
// z-index (20) beat the top screen's (2) because the hidden screen was no stacking context.
// jsdom applies no CSS modules, so these read the rules; the harness render check is the proof.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (file: string) => readFileSync(resolve(process.cwd(), 'src/styles/modules/mobile', file), 'utf8');
const rule = (css: string, selector: string) => css.match(new RegExp(`(^|\\n)${selector.replace(/[.[\]]/g, '\\$&')} \\{[^}]*\\}`))?.[0] ?? '';

describe('a screen under the top one never shows through it', () => {
  it('keeps each stacked screen in its own layer, so nothing in it paints over the screen above', () => {
    const slot = rule(read('PhoneStack.module.css'), '.slot');
    expect(slot).toContain('position: absolute');
    expect(slot).toMatch(/isolation:\s*isolate/);
  });

  it('shows the chat search bar only while its own screen is shown', () => {
    const shown = rule(read('Chat.module.css'), '.searchShown');
    expect(shown).toContain('transform: none');
    expect(shown).toMatch(/visibility:\s*inherit/);
    expect(shown).not.toMatch(/visibility:\s*visible/);
  });
});
