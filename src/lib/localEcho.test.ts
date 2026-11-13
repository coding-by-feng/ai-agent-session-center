// localEcho.test.ts — the mosh-style predictor behind instant typing. A guess is shown only once this
// line's input has echoed back once, so text a program never echoes (a password) is never drawn.
import { describe, it, expect } from 'vitest';
import {
  INITIAL_ECHO,
  GUESS_TIMEOUT_MS,
  MAX_MISSES,
  SLOW_ECHO_MS,
  charWidth,
  echoExpire,
  echoInput,
  echoOutput,
  echoReset,
  isSlowEcho,
  isTerminalReport,
  shownGuesses,
  type EchoState,
  type ScreenView,
} from './localEcho';

/** A screen of `cols` columns: one row of text per entry, the cursor where the test puts it. */
function screen(rows: string[], cursorRow: number, cursorCol: number, cols = 40): ScreenView {
  return {
    cursorRow,
    cursorCol,
    cols,
    cellAt: (row, col) => {
      const chars = [...(rows[row] ?? '')];
      return chars[col] ?? '';
    },
  };
}

/** The prompt row after `typed` has echoed: "❯ " then the text, cursor after it. */
const prompt = (typed: string, cols = 40): ScreenView => screen([`❯ ${typed}`], 0, 2 + [...typed].length, cols);

/** Type `keys`, one call per key, against an unchanged screen (no echo yet). */
function type(state: EchoState, keys: string, view: ScreenView, now = 0): EchoState {
  return [...keys].reduce((s, key) => echoInput(s, key, view, now), state);
}

const shown = (s: EchoState): string => shownGuesses(s).map((g) => g.ch).join('');

/** Trusted state: "a" typed and echoed. */
function trusted(): EchoState {
  const s = echoInput(INITIAL_ECHO, 'a', prompt(''), 0);
  return echoOutput(s, prompt('a'), 10);
}

describe('localEcho — trust', () => {
  it('draws nothing until the line has echoed a key back', () => {
    const s = type(INITIAL_ECHO, 'ab', prompt(''));
    expect(shown(s)).toBe('');
    expect(s.trusted).toBe(false);
  });

  it('trusts the line once the first key echoes, and draws what was typed meanwhile', () => {
    const typed = type(INITIAL_ECHO, 'abc', prompt(''));
    const s = echoOutput(typed, prompt('a'), 10);
    expect(s.trusted).toBe(true);
    expect(shown(s)).toBe('bc');
    expect(shownGuesses(s).map((g) => g.col)).toEqual([3, 4]);
  });

  it('never draws a password: a prompt that does not echo is never trusted', () => {
    const view = screen(['Password: '], 0, 10);
    let s = type(INITIAL_ECHO, 'hunter2', view);
    s = echoOutput(s, view, 50);
    expect(shown(s)).toBe('');
    s = echoExpire(s, GUESS_TIMEOUT_MS + 1);
    expect(shown(s)).toBe('');
    expect(type(s, 'x', view)).toSatisfy((next: EchoState) => shown(next) === '');
  });

  it('starts a new line untrusted after Enter', () => {
    const s = echoInput(trusted(), '\r', prompt('a'), 20);
    expect(s.trusted).toBe(false);
    expect(shown(type(s, 'b', prompt('a')))).toBe('');
  });

  it.each([
    screen(['Continue? a', 'Password: '], 1, 10),
    screen(['Password: '], 0, 10),
    screen(['PW:'], 0, 3),
  ])('does not carry trust into an output-only password prompt', (password) => {
    const s = echoOutput(trusted(), password, 50);
    expect(shown(type(s, 'synthetic-secret', password, 100))).toBe('');
    expect(shown(type(trusted(), 'synthetic-secret', password, 100))).toBe('');
  });
});

describe('localEcho — guessing', () => {
  it('draws each key at the next cell at once', () => {
    const s = type(trusted(), 'bcd', prompt('a'), 20);
    expect(shown(s)).toBe('bcd');
    expect(shownGuesses(s).map((g) => [g.row, g.col])).toEqual([[0, 3], [0, 4], [0, 5]]);
  });

  it('confirms guesses as their echo arrives and keeps the rest', () => {
    let s = type(trusted(), 'bcd', prompt('a'), 20);
    s = echoOutput(s, prompt('ab'), 30);
    expect(shown(s)).toBe('cd');
    s = echoOutput(s, prompt('abcd'), 40);
    expect(shown(s)).toBe('');
    expect(s.misses).toBe(0);
  });

  it('keeps a guess while the cursor has not reached past it, even if the cell already shows that letter', () => {
    // Claude's grey suggestion "Try ..." sits after the caret; its "T" must not confirm a typed "T".
    const s = type(trusted(), 'T', prompt('a'), 20);
    const ghost = screen(['❯ aTry "refactor"'], 0, 3);
    expect(shown(echoOutput(s, ghost, 30))).toBe('T');
  });

  // Retyping a deleted word: the old word's echo arrives first and would "confirm" the new guesses, then the
  // deletes' echoes pull the cursor back (real Claude over a 150 ms link). So Backspace drops every guess.
  it('drops the guesses on Backspace and probes again after a pause', () => {
    const s = echoInput(type(trusted(), 'bc', prompt('a'), 20), '\x7f', prompt('a'), 21);
    expect(shown(s)).toBe('');
    expect(s.trusted).toBe(false);
    expect(s.misses).toBe(0);
  });

  // Claude "types" a space by moving the cursor on, so the cell stays empty (real Claude Code 2.1.322).
  it('confirms a space that the program drew as an empty cell', () => {
    const s = echoOutput(type(trusted(), ' ', prompt('a'), 20), screen(['❯ a'], 0, 4), 30);
    expect(s.guesses).toHaveLength(0);
    expect(s.misses).toBe(0);
  });

  it('stops guessing and re-probes on Backspace with nothing guessed', () => {
    const s = echoInput(trusted(), '\x7f', prompt('a'), 20);
    expect(s.trusted).toBe(false);
  });

  it('gives a wide (CJK) character two cells', () => {
    const s = type(trusted(), '你好', prompt('a'), 20);
    expect(shownGuesses(s).map((g) => [g.col, g.width])).toEqual([[3, 2], [5, 2]]);
  });

  it('treats IME text that arrives in one chunk as one key per character', () => {
    const s = echoInput(trusted(), '你好', prompt('a'), 20);
    expect(shown(s)).toBe('你好');
  });

  it('does not guess past the end of the row', () => {
    const narrow = prompt('a', 5); // "❯ a" leaves cols 3 and 4
    const s = type(trusted(), 'bcd', narrow, 20);
    expect(shown(s)).toBe('');
    expect(s.trusted).toBe(false);
  });
});

describe('localEcho — when the guess is wrong', () => {
  it('drops every guess when the echo differs', () => {
    const s = echoOutput(type(trusted(), 'bc', prompt('a'), 20), prompt('aX'), 30);
    expect(shown(s)).toBe('');
    expect(s.misses).toBe(1);
  });

  it('drops every guess when the cursor jumps to another row (the program redrew)', () => {
    const s = echoOutput(type(trusted(), 'b', prompt('a'), 20), screen(['❯ a', 'menu'], 1, 0), 30);
    expect(shown(s)).toBe('');
    expect(s.misses).toBe(1);
  });

  it('drops guesses that wait longer than the timeout', () => {
    const s = echoExpire(type(trusted(), 'b', prompt('a'), 20), 20 + GUESS_TIMEOUT_MS + 1);
    expect(shown(s)).toBe('');
    expect(s.misses).toBe(1);
  });

  it(`stops guessing after ${MAX_MISSES} misses in a row, until Enter`, () => {
    let s = trusted();
    let current = 'a';
    for (let i = 0; i < MAX_MISSES; i += 1) {
      const t = 100 + i * 100;
      s = type(s, 'b', prompt(current), t);
      current += 'X';
      s = echoOutput(s, prompt(current), t + 10); // miss
      s = echoOutput(echoInput(s, 'a', prompt(current), t + 60), prompt(current + 'a'), t + 70); // a pause, then re-trust
      current += 'a';
    }
    expect(s.disabled).toBe(true);
    expect(shown(type(s, 'b', prompt('aXa'), 40))).toBe('');
    const next = echoInput(s, '\r', prompt('aXa'), 50);
    expect(next.disabled).toBe(false);
  });

  it('re-trusting after a miss keeps the count; a confirmed shown guess clears it', () => {
    let s = echoOutput(type(trusted(), 'b', prompt('a'), 20), prompt('aX'), 30);
    s = echoOutput(echoInput(s, 'c', prompt('aX'), 100), prompt('aXc'), 110);
    expect(s.trusted).toBe(true);
    expect(s.misses).toBe(1);
    s = echoOutput(echoInput(s, 'd', prompt('aXc'), 120), prompt('aXcd'), 130);
    expect(s.misses).toBe(0);
  });

  it('a wrong guess the user never saw is not a miss', () => {
    const s = echoOutput(echoInput(INITIAL_ECHO, 'a', prompt(''), 0), prompt('X'), 10);
    expect(s.misses).toBe(0);
    expect(s.trusted).toBe(false);
  });

  // After a reset the real cursor is behind: keys typed before it are still on their way. Probing from it then
  // puts every guess one cell short (seen against real Claude with a 150 ms link).
  it('waits for a pause in typing before probing again after a miss', () => {
    let s = echoInput(trusted(), 'b', prompt('a'), 100); // srtt 10 ms
    s = echoOutput(s, prompt('aX'), 104); // miss
    s = echoInput(s, 'c', prompt('aX'), 105); // 5 ms after the last key: "b" may still be on its way
    expect(s.guesses).toHaveLength(0);
    s = echoInput(s, 'd', prompt('aXc'), 200); // a pause longer than the echo time
    expect(s.guesses.map((g) => [g.ch, g.col])).toEqual([['d', 5]]);
  });
});

describe('localEcho — keys it never guesses', () => {
  it.each([
    ['an arrow key', '\x1b[D'],
    ['Esc', '\x1b'],
    ['Tab', '\t'],
    ['Ctrl+U', '\x15'],
    ['a bracketed paste', '\x1b[200~text\x1b[201~'],
  ])('drops the guesses and re-probes on %s', (_label, key) => {
    const s = echoInput(type(trusted(), 'b', prompt('a'), 20), key, prompt('a'), 21);
    expect(shown(s)).toBe('');
    expect(s.trusted).toBe(false);
  });

  it.each([
    ['a mouse report (SGR)', '\x1b[<0;10;5M'],
    ['a mouse report (X10)', '\x1b[M !!'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['a cursor position report', '\x1b[12;40R'],
    ['a device attributes reply', '\x1b[?1;2c'],
  ])('ignores %s: the terminal sends it, not the user', (_label, report) => {
    const before = type(trusted(), 'b', prompt('a'), 20);
    expect(isTerminalReport(report)).toBe(true);
    expect(echoInput(before, report, prompt('a'), 21)).toBe(before);
  });

  it('reset drops guesses and re-probes but keeps the echo timing', () => {
    const s = echoReset(type(trusted(), 'b', prompt('a'), 20));
    expect(shown(s)).toBe('');
    expect(s.trusted).toBe(false);
    expect(s.srtt).not.toBeNull();
  });
});

describe('localEcho — slow echo flag', () => {
  it('is off while echoes come back fast', () => {
    expect(isSlowEcho(trusted())).toBe(false);
  });

  it(`turns on when echoes take longer than ${SLOW_ECHO_MS} ms`, () => {
    let s = echoOutput(echoInput(INITIAL_ECHO, 'a', prompt(''), 0), prompt('a'), 400);
    s = echoOutput(type(s, 'b', prompt('a'), 500), prompt('ab'), 900);
    expect(isSlowEcho(s)).toBe(true);
  });
});

describe('charWidth', () => {
  it.each([['a', 1], ['~', 1], [' ', 1], ['你', 2], ['。', 2], ['ｱ', 1], ['\t', 0], ['\x07', 0], ['é', 1], ['😀', 0]])(
    '%s → %i',
    (ch, width) => {
      expect(charWidth(ch)).toBe(width);
    },
  );
});
