import { describe, it, expect } from 'vitest';
import {
  advanceToken,
  completionKeys,
  lastTypedAfter,
  placeMenuAtCaret,
  startsToken,
} from './terminalCommandTrigger';

const midPrompt = { charBefore: ' ', lineBefore: '❯ hello ' };

describe('startsToken', () => {
  it('opens on a `/` after whitespace mid-prompt (where Claude offers one ghost guess)', () => {
    expect(startsToken('/', midPrompt)).toBe(true);
  });

  it('opens at the start of a continuation line of a multi-line prompt', () => {
    expect(startsToken('/', { charBefore: ' ', lineBefore: '  ' })).toBe(true);
    expect(startsToken('/', { charBefore: '', lineBefore: '' })).toBe(true);
  });

  it('stays shut where the CLI opens its own list: the first character of the input', () => {
    expect(startsToken('/', { charBefore: ' ', lineBefore: '❯ ' })).toBe(false); // Claude
    expect(startsToken('/', { charBefore: ' ', lineBefore: '› ' })).toBe(false); // Codex
    expect(startsToken('/', { charBefore: ' ', lineBefore: '> ' })).toBe(false); // older Claude
  });

  it('stays shut inside a word or path', () => {
    expect(startsToken('/', { charBefore: 'a', lineBefore: '❯ src' })).toBe(false);
  });

  it('only `/` starts one (Codex shows its own `$` list mid-line)', () => {
    expect(startsToken('$', midPrompt)).toBe(false);
    expect(startsToken('a', midPrompt)).toBe(false);
  });
});

describe('startsToken before the echo lands (a quick `space /`)', () => {
  // The screen still shows the character before the space.
  const stale = { charBefore: 'e', lineBefore: '❯ more' };

  it('a space typed just before wins over the stale screen', () => {
    expect(startsToken('/', stale)).toBe(false); // what the screen alone says
    expect(startsToken('/', stale, ' ')).toBe(true);
  });

  it('a letter typed just before keeps it shut, whatever the screen says', () => {
    expect(startsToken('/', midPrompt, 'x')).toBe(false);
  });

  it('just after Enter it is a fresh input, where the CLI lists itself', () => {
    expect(startsToken('/', { charBefore: ' ', lineBefore: '❯ old prompt ' }, '\r')).toBe(false);
  });

  it('still leaves the first character of the input to the CLI', () => {
    expect(startsToken('/', { charBefore: ' ', lineBefore: '❯ ' }, ' ')).toBe(false);
  });
});

describe('lastTypedAfter', () => {
  it('remembers typed text and Enter; forgets after a caret move or Backspace', () => {
    expect(lastTypedAfter('a')).toBe('a');
    expect(lastTypedAfter('pasted words ')).toBe(' ');
    expect(lastTypedAfter('\r')).toBe('\r');
    expect(lastTypedAfter('\x1b[D')).toBeNull();
    expect(lastTypedAfter('\x7f')).toBeNull();
    expect(lastTypedAfter('')).toBeNull();
  });
});

describe('advanceToken', () => {
  it('grows with printable input, including several characters at once', () => {
    expect(advanceToken({ query: '' }, 't')).toEqual({ query: 't' });
    expect(advanceToken({ query: 't' }, 'el')).toEqual({ query: 'tel' });
    expect(advanceToken({ query: 'a' }, ':')).toEqual({ query: 'a:' });
  });

  it('shrinks on Backspace and ends when the `/` itself is deleted', () => {
    expect(advanceToken({ query: 'te' }, '\x7f')).toEqual({ query: 't' });
    expect(advanceToken({ query: 'te' }, '\b')).toEqual({ query: 't' });
    expect(advanceToken({ query: '' }, '\x7f')).toBeNull();
  });

  it('ends on whitespace, Enter, escape sequences and pastes holding a space', () => {
    expect(advanceToken({ query: 'te' }, ' ')).toBeNull();
    expect(advanceToken({ query: 'te' }, '\r')).toBeNull();
    expect(advanceToken({ query: 'te' }, '\x1b[D')).toBeNull();
    expect(advanceToken({ query: 'te' }, 'a b')).toBeNull();
    expect(advanceToken({ query: 'te' }, '')).toBeNull();
  });
});

describe('completionKeys', () => {
  it('types only the rest of the name when the pick starts with what was typed', () => {
    expect(completionKeys({ query: 'tel' }, '/teleport')).toBe('eport ');
  });

  it('erases the typed token first when the pick matched elsewhere in its name', () => {
    expect(completionKeys({ query: 'tel' }, '/krt-tel')).toBe('\x7f\x7f\x7f\x7f/krt-tel ');
  });
});

describe('placeMenuAtCaret', () => {
  const viewport = { width: 1200, height: 800 };

  it('opens above the `/` when there is room, left edge on the `/`', () => {
    const p = placeMenuAtCaret({ left: 300, top: 600, bottom: 618 }, viewport);
    expect(p.left).toBe(300);
    expect(p.bottom).toBe(800 - 600 + 4);
    expect(p.top).toBeUndefined();
    expect(p.maxHeight).toBe(400); // half the viewport
  });

  it('opens below near the top of the screen', () => {
    const p = placeMenuAtCaret({ left: 300, top: 40, bottom: 58 }, viewport);
    expect(p.top).toBe(62);
    expect(p.bottom).toBeUndefined();
  });

  it('stays 8px inside the right edge, and inside a narrow window', () => {
    const p = placeMenuAtCaret({ left: 1100, top: 600, bottom: 618 }, viewport);
    expect(p.left + p.width).toBe(1200 - 8);
    const narrow = placeMenuAtCaret({ left: 200, top: 300, bottom: 318 }, { width: 320, height: 600 });
    expect(narrow.left).toBe(8);
    expect(narrow.width).toBe(304);
  });
});
