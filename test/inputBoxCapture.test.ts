// test/inputBoxCapture.test.ts — the queue's "take the text from Claude's input box" (Nov 13 2026):
// read what the user typed or dictated (hold Space) into Claude's ❯ box off the screen, then clear it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  clearKeysFor,
  forgetTerminalWrites,
  isSendPending,
  noteTerminalWrite,
  parseInputBox,
  SEND_PENDING_MS,
  takeInputBox,
  type InputBoxDeps,
} from '../server/inputBoxCapture.js';
import { renderScreenCells, type ScreenCell } from '../server/headlessScreen.js';

/** Screen width: rows are padded with blanks to it, as a real terminal's are. */
const W = 60;
const RULE = '─'.repeat(W);
const row = (text: string, dim: (i: number) => boolean = () => false): ScreenCell[] =>
  [...text.padEnd(W, ' ')].slice(0, W).map((ch, i) => ({ ch, dim: dim(i) }));
const allDim = () => true;
const box = (...lines: string[]) => [row(RULE), row(`❯ ${lines[0]}`), ...lines.slice(1).map((l) => row(`  ${l}`)), row(RULE)];
const FOOTER = row('  ⏸ manual mode on · ? for shortcuts');

describe('parseInputBox', () => {
  it('reads one typed row above its footer', () => {
    expect(parseInputBox([row('header'), ...box('run the tests'), FOOTER])).toEqual({ text: 'run the tests', rows: 1 });
  });

  it('joins word-wrapped rows with one space', () => {
    expect(parseInputBox([...box('fix the queue so a paused item can be edited', 'without losing its schedule'), FOOTER]))
      .toEqual({ text: 'fix the queue so a paused item can be edited without losing its schedule', rows: 2 });
  });

  it('joins a token broken mid-way, and CJK rows, with no space', () => {
    // Text reaches the box's right edge (2 blank cells of margin) and the two fragments are wider than a row.
    const head = `❯ open ${'/a'.repeat(30)}`.slice(0, W - 2);
    const rows = [row(RULE), row(head), row('  /b/c.tsx please'), row(RULE)];
    expect(parseInputBox(rows)?.text).toBe(`${head.slice(2)}/b/c.tsx please`);
    expect(parseInputBox([...box('把队列里暂停的项目', '改成可以编辑')])?.text).toBe('把队列里暂停的项目改成可以编辑');
  });

  it('keeps the space after a word that just fills its row', () => {
    const words = '❯ ' + 'word '.repeat(12);
    const head = words.slice(0, W - 2).trimEnd().padEnd(W - 2, 'x'); // ends in a short word at the edge
    const rows = [row(RULE), row(head), row('  next words here'), row(RULE)];
    expect(parseInputBox(rows)?.text).toBe(`${head.slice(2)} next words here`);
  });

  it('reports an empty box when only dim text is there (placeholder hint or next-prompt suggestion)', () => {
    expect(parseInputBox([row(RULE), row('❯ Try "create a util logging.py that..."', (i) => i >= 2), row(RULE)]))
      .toEqual({ text: '', rows: 1 });
    expect(parseInputBox([row(RULE), row('❯ ', allDim), row(RULE)])).toEqual({ text: '', rows: 1 });
  });

  it('keeps typed text and drops a dim tail drawn after it', () => {
    expect(parseInputBox([row(RULE), row('❯ run the tests', (i) => i >= 9), row(RULE)]))
      .toEqual({ text: 'run the', rows: 1 });
  });

  it('is null when a dialog sits below an old box: never the leftover box above it', () => {
    const rows = [
      ...box('the prompt that was already sent'),
      row('Bash command'),
      row(RULE),
      row(' Do you want to proceed?'),
      row(' ❯ 1. Yes'),
      row('   2. No, and tell Claude what to do differently: my typed note'),
    ];
    expect(parseInputBox(rows)).toBeNull();
  });

  it('is null when a tall dialog or output fills the bottom of the screen', () => {
    const tail = Array.from({ length: 8 }, (_, i) => row(`option line ${i}`));
    expect(parseInputBox([...box('old'), ...tail])).toBeNull();
    expect(parseInputBox([row('Do you want to proceed?'), row('❯ 1. Yes'), row('  2. No')])).toBeNull();
    expect(parseInputBox([])).toBeNull();
  });

  it('is null when the box is taller than the screen (its top rule scrolled off)', () => {
    expect(parseInputBox([row('  long dictation continues'), row('  and ends here'), row(RULE), FOOTER])).toBeNull();
  });

  it('reads the box at the bottom when an older one is higher up', () => {
    const rows = [...box('old'), row('output'), ...box('new text'), FOOTER];
    expect(parseInputBox(rows)?.text).toBe('new text');
  });

  it('reads an empty box off a real Claude Code screen (dim suggestion only)', async () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/claude-prompt-suggestion.json', import.meta.url), 'utf8'),
    ) as { cols: number; rows: number; chunks: string[] };
    const rows = await renderScreenCells({ bytes: Buffer.from(fixture.chunks.join('')), cols: fixture.cols, rows: fixture.rows });
    expect(parseInputBox(rows)?.text).toBe('');
  });
});

describe('clearKeysFor', () => {
  it('sends enough Ctrl+U for every row and the line breaks between them, plus a margin', () => {
    // Claude's Ctrl+U deletes to the start of the visual row; on an empty row it eats the line break.
    expect(clearKeysFor(1)).toBe('\x15'.repeat(4));
    expect(clearKeysFor(3)).toBe('\x15'.repeat(8));
  });
});

describe('a send between its text and its Enter', () => {
  beforeEach(() => forgetTerminalWrites());

  it('is pending after a text write until its Enter, or until it is too old to be one', () => {
    noteTerminalWrite('t1', 'queued prompt', 1_000);
    expect(isSendPending('t1', 2_000)).toBe(true);
    noteTerminalWrite('t1', '\r', 2_100);
    expect(isSendPending('t1', 2_200)).toBe(false);
    noteTerminalWrite('t1', 'typed only', 3_000);
    expect(isSendPending('t1', 3_000 + SEND_PENDING_MS)).toBe(false);
  });

  it('ignores keys and escape sequences (toolbar arrows, Esc, Ctrl+U)', () => {
    for (const key of ['\x1b', '\x1b[A', '\x15\x15', '\t']) noteTerminalWrite('t1', key, 1_000);
    expect(isSendPending('t1', 1_001)).toBe(false);
  });
});

describe('takeInputBox', () => {
  const screens = (...seq: ScreenCell[][][]) => {
    let i = 0;
    return () => seq[Math.min(i++, seq.length - 1)];
  };

  function deps(read: () => ScreenCell[][] | null, over: Partial<InputBoxDeps> = {}) {
    const write = vi.fn();
    const d: InputBoxDeps = {
      readScreen: async () => read(),
      write,
      wait: async () => {},
      agentInFront: () => true,
      sendPending: () => false,
      ...over,
    };
    return { d, write };
  }
  const EMPTY = [row(RULE), row('❯ ', allDim), row(RULE), FOOTER];

  it('takes the text, clears the box with Ctrl+U and confirms it is empty', async () => {
    const { d, write } = deps(screens([...box('hello there', 'second row'), FOOTER], EMPTY));
    expect(await takeInputBox('t1', d)).toEqual({ ok: true, text: 'hello there second row', cleared: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('t1', clearKeysFor(2));
  });

  it('writes nothing when the box is empty', async () => {
    const { d, write } = deps(screens(EMPTY));
    expect(await takeInputBox('t1', d)).toEqual({ ok: true, text: '', cleared: true });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses, writing nothing, when a dialog replaced the box', async () => {
    const { d, write } = deps(screens([...box('already sent'), row(RULE), row(' Proceed?'), row(' ❯ 1. Yes')]));
    expect(await takeInputBox('t1', d)).toEqual({ ok: false, reason: 'no-input-box' });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a box holding a paste or image placeholder (the real content is not on screen)', async () => {
    for (const text of ['[Pasted text #1 +40 lines] and look at this', 'see [Image #2]']) {
      const { d, write } = deps(screens([...box(text), FOOTER]));
      expect(await takeInputBox('t1', d)).toEqual({ ok: false, reason: 'has-attachment' });
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('refuses while a send waits for its Enter, without reading the screen', async () => {
    const read = vi.fn(() => [...box('queued prompt text'), FOOTER]);
    const { d, write } = deps(read, { sendPending: () => true });
    expect(await takeInputBox('t1', d)).toEqual({ ok: false, reason: 'send-in-progress' });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when Claude is no longer the program in front (its old box still on screen)', async () => {
    const { d, write } = deps(screens([...box('stale text'), FOOTER]), { agentInFront: () => false });
    expect(await takeInputBox('t1', d)).toEqual({ ok: false, reason: 'not-agent' });
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses when the terminal has no screen', async () => {
    const { d } = deps(() => null);
    expect(await takeInputBox('gone', d)).toEqual({ ok: false, reason: 'no-terminal' });
  });

  it('still returns the text but says so when the box did not clear', async () => {
    const full = [...box('stuck text'), FOOTER];
    const { d } = deps(screens(full, full));
    expect(await takeInputBox('t1', d)).toEqual({ ok: true, text: 'stuck text', cleared: false });
  });
});
