// src/lib/autocompleteTrigger.test.ts — trigger parsing for the queue prompt
// autocomplete. Three sigils are live: `@` (files), `/` (commands) and `$`
// (Codex skills). The LAST valid sigil before the caret wins — the old
// check-@-then-/ order only worked by accident (the "fragment has no space"
// rule happened to reject the earlier sigil) and breaks outright once a third
// sigil is added.
import { describe, it, expect } from 'vitest';
import { parseTrigger } from './autocompleteTrigger';

describe('parseTrigger', () => {
  it('returns null with no sigil', () => {
    expect(parseTrigger('hello world', 11)).toBeNull();
  });

  it('detects / at start of text', () => {
    expect(parseTrigger('/clear', 6)).toEqual({
      type: 'command',
      query: 'clear',
      triggerStart: 0,
    });
  });

  it('detects $ at start of text', () => {
    expect(parseTrigger('$retouch', 8)).toEqual({
      type: 'skill',
      query: 'retouch',
      triggerStart: 0,
    });
  });

  it('detects @ at start of text', () => {
    expect(parseTrigger('@src/', 5)).toEqual({
      type: 'file',
      query: 'src/',
      triggerStart: 0,
    });
  });

  it('requires the sigil to be at index 0 or after whitespace', () => {
    // mid-word `$` (shell-ish text like `foo$bar`) must not open a menu
    expect(parseTrigger('foo$bar', 7)).toBeNull();
    expect(parseTrigger('a/b', 3)).toBeNull();
    expect(parseTrigger('mail@example', 12)).toBeNull();
  });

  it('detects a sigil after whitespace', () => {
    expect(parseTrigger('please $ascii', 13)).toEqual({
      type: 'skill',
      query: 'ascii',
      triggerStart: 7,
    });
  });

  it('stops at a space — a completed token no longer triggers', () => {
    expect(parseTrigger('$ascii-review-first then do X', 29)).toBeNull();
  });

  it('picks the LAST valid sigil, not the first found', () => {
    // `$` typed after an already-completed `/command`
    expect(parseTrigger('/plan $reto', 11)).toEqual({
      type: 'skill',
      query: 'reto',
      triggerStart: 6,
    });
    // `/` typed after an already-completed `$skill`
    expect(parseTrigger('$todo /cle', 10)).toEqual({
      type: 'command',
      query: 'cle',
      triggerStart: 6,
    });
    // `@` typed after an already-completed `$skill`
    expect(parseTrigger('$todo @src', 10)).toEqual({
      type: 'file',
      query: 'src',
      triggerStart: 6,
    });
  });

  it('a bare sigil yields an empty query (bare @ / bare $ open the picker)', () => {
    expect(parseTrigger('@', 1)).toEqual({ type: 'file', query: '', triggerStart: 0 });
    expect(parseTrigger('$', 1)).toEqual({ type: 'skill', query: '', triggerStart: 0 });
    expect(parseTrigger('/', 1)).toEqual({ type: 'command', query: '', triggerStart: 0 });
  });

  it('only looks at text before the caret', () => {
    // caret sits right after `/cl`; the trailing text is ignored
    expect(parseTrigger('/clear rest', 3)).toEqual({
      type: 'command',
      query: 'cl',
      triggerStart: 0,
    });
  });

  it('handles a path-like fragment after @ without tripping on inner slashes', () => {
    expect(parseTrigger('@src/lib/comm', 13)).toEqual({
      type: 'file',
      query: 'src/lib/comm',
      triggerStart: 0,
    });
  });

  it('treats a newline as whitespace anchoring', () => {
    expect(parseTrigger('line one\n$todo', 14)).toEqual({
      type: 'skill',
      query: 'todo',
      triggerStart: 9,
    });
  });

  it('a newline ends the fragment just like a space', () => {
    // multi-line queued prompt: the `/clear` on line 1 is done being typed
    expect(parseTrigger('/clear\nnow do the thing', 22)).toBeNull();
  });
});
