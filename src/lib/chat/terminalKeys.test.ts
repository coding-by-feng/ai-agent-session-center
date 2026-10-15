// terminalKeys.test.ts — the Terminal segment's key bar and its sticky Ctrl (AASC-45).
import { describe, it, expect } from 'vitest';
import { KEY_BAR, KEY_LABELS, ctrlChar, keySequence, pressKey, typeWithCtrl } from './terminalKeys';

describe('the key bar', () => {
  it('draws Esc, Tab, Ctrl, the four arrows, 1 2 3 and Enter, in that order', () => {
    expect(KEY_BAR).toEqual(['esc', 'tab', 'ctrl', 'up', 'down', 'left', 'right', '1', '2', '3', 'enter']);
  });

  it('names every key out loud', () => {
    for (const key of KEY_BAR) expect(KEY_LABELS[key]).toBeTruthy();
  });
});

describe('keySequence', () => {
  it('writes what a terminal keyboard writes', () => {
    expect(keySequence('esc', false)).toBe('\x1b');
    expect(keySequence('tab', false)).toBe('\t');
    expect(keySequence('up', false)).toBe('\x1b[A');
    expect(keySequence('down', false)).toBe('\x1b[B');
    expect(keySequence('right', false)).toBe('\x1b[C');
    expect(keySequence('left', false)).toBe('\x1b[D');
    expect(keySequence('2', false)).toBe('2');
    expect(keySequence('enter', false)).toBe('\r');
  });

  it('sends Ctrl+arrow as the modified arrow (a word jump)', () => {
    expect(keySequence('left', true)).toBe('\x1b[1;5D');
    expect(keySequence('up', true)).toBe('\x1b[1;5A');
  });

  it('leaves keys Ctrl does nothing to as they are', () => {
    expect(keySequence('enter', true)).toBe('\r');
    expect(keySequence('1', true)).toBe('1');
  });

  it('sends nothing for Ctrl itself', () => {
    expect(keySequence('ctrl', false)).toBe('');
  });
});

describe('ctrlChar', () => {
  it('turns a letter into its control code, either case', () => {
    expect(ctrlChar('c')).toBe('\x03');
    expect(ctrlChar('C')).toBe('\x03');
    expect(ctrlChar('a')).toBe('\x01');
    expect(ctrlChar('z')).toBe('\x1a');
  });

  it('knows the punctuation controls', () => {
    expect(ctrlChar('[')).toBe('\x1b');
    expect(ctrlChar('\\')).toBe('\x1c');
    expect(ctrlChar(']')).toBe('\x1d');
    expect(ctrlChar('_')).toBe('\x1f');
    expect(ctrlChar(' ')).toBe('\x00');
    expect(ctrlChar('?')).toBe('\x7f');
  });

  it('has nothing for anything else', () => {
    expect(ctrlChar('1')).toBeNull();
    expect(ctrlChar('é')).toBeNull();
    expect(ctrlChar('cd')).toBeNull();
    expect(ctrlChar('')).toBeNull();
  });
});

describe('sticky Ctrl', () => {
  it('arms on a tap and disarms on a second one, sending nothing', () => {
    expect(pressKey({ ctrl: false }, 'ctrl')).toEqual({ send: null, ctrl: true });
    expect(pressKey({ ctrl: true }, 'ctrl')).toEqual({ send: null, ctrl: false });
  });

  it('modifies the next key bar key only, then lets go', () => {
    expect(pressKey({ ctrl: true }, 'left')).toEqual({ send: '\x1b[1;5D', ctrl: false });
    expect(pressKey({ ctrl: false }, 'left')).toEqual({ send: '\x1b[D', ctrl: false });
  });

  it('Ctrl, then C typed on the keyboard, sends ^C at once and lets go', () => {
    expect(typeWithCtrl({ ctrl: true }, 'c')).toEqual({ send: '\x03', ctrl: false, consumed: true });
  });

  it('a character Ctrl means nothing to is typed as it is, and Ctrl lets go', () => {
    expect(typeWithCtrl({ ctrl: true }, '1')).toEqual({ send: null, ctrl: false, consumed: false });
  });

  it('without Ctrl, typing is just typing', () => {
    expect(typeWithCtrl({ ctrl: false }, 'c')).toEqual({ send: null, ctrl: false, consumed: false });
  });
});
