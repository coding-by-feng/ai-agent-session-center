// terminalViewport.test.ts — the view's rule around a write or a fit (Nov 23 2026): a terminal left at the bottom
// stays at the bottom, one scrolled up stays on its line. Run against the real xterm buffer (@xterm/headless shares
// xterm's core), with Codex's way of printing history: a scroll region above its input box.
import { describe, it, expect } from 'vitest';
import headless from '@xterm/headless';
import { markView, restoreView } from './terminalViewport';

type Term = InstanceType<typeof headless.Terminal>;

const write = (t: Term, s: string) => new Promise<void>((r) => t.write(s, r));

async function terminal(): Promise<Term> {
  const t = new headless.Terminal({ cols: 80, rows: 24, scrollback: 5000, allowProposedApi: true });
  for (let i = 0; i < 60; i++) await write(t, `line ${i}\r\n`);
  return t;
}

const plain = (i: number) => `out ${i}\r\nmore ${i}\r\n`;
// codex-rs insert_history: region 1..20 (its box below), CRLF + the line, reset the region, back to the box.
const codex = (i: number) => `\x1b[1;20r\x1b[20;1H\r\nhist ${i}\r\nhist ${i}b\x1b[r\x1b[22;1H`;

/** Five writes with the hook's rule around each; how far above the bottom the view ends after each. */
async function drift(t: Term, chunk: (i: number) => string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < 5; i++) {
    const mark = markView(t);
    await write(t, chunk(i));
    restoreView(t, mark);
    out.push(t.buffer.active.baseY - t.buffer.active.viewportY);
  }
  return out;
}

describe('terminalViewport', () => {
  it('a terminal left at the bottom stays at the bottom as plain output arrives', async () => {
    expect(await drift(await terminal(), plain)).toEqual([0, 0, 0, 0, 0]);
  });

  it('…and as Codex inserts history above its input box (the Nov 23 2026 jump)', async () => {
    expect(await drift(await terminal(), codex)).toEqual([0, 0, 0, 0, 0]);
  });

  it('a terminal scrolled up to read stays on the same line, whichever way output arrives', async () => {
    for (const chunk of [plain, codex]) {
      const t = await terminal();
      t.scrollToLine(10);
      const top = t.buffer.active.getLine(10)?.translateToString(true);
      await drift(t, chunk);
      expect(t.buffer.active.viewportY).toBe(10);
      expect(t.buffer.active.getLine(t.buffer.active.viewportY)?.translateToString(true)).toBe(top);
    }
  });

  it('a resize that reflows lines keeps a bottom view at the bottom', async () => {
    const t = await terminal();
    for (let i = 0; i < 20; i++) await write(t, `${'w'.repeat(70)} ${i}\r\n`);
    const mark = markView(t);
    t.resize(40, 24); // the long lines now wrap: more rows, absolute lines move
    restoreView(t, mark);
    expect(t.buffer.active.viewportY).toBe(t.buffer.active.baseY);
  });
});
