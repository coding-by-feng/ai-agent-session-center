// test/popoutBounds.test.ts — per-kind popout bounds persistence.
//
// Root cause this fixes: `computePopoutBounds()` read/wrote ONE shared
// bounds file for all four popout kinds (terminal float, project browser,
// whole-session, generic internal route). Resizing or maximizing a
// content-heavy PROJECT or SESSION window permanently poisoned the size of
// every later TERMINAL popout — a fresh Explain/Translate session opened at
// whatever huge size the user last left a project browser at, mostly empty.
import { describe, it, expect } from 'vitest';
import {
  parsePopoutBoundsFile, mergePopoutBounds, isWindowBounds,
  POPOUT_KINDS, POPOUT_DEFAULT_SIZES,
} from '../electron/popoutBounds.js';
import type { WindowBounds } from '../electron/popoutBounds.js';

const B = (n: number): WindowBounds => ({ x: n, y: n, width: 800 + n, height: 600 + n });

describe('isWindowBounds', () => {
  it('accepts a well-formed bounds object', () => {
    expect(isWindowBounds({ x: 0, y: 0, width: 100, height: 100 })).toBe(true);
  });

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    ['string', 'a string'],
    [{ x: 0, y: 0, width: 100 }, 'missing height'],
    [{ x: '0', y: 0, width: 100, height: 100 }, 'x as a string'],
  ])('rejects %s (%s)', (v) => {
    expect(isWindowBounds(v)).toBe(false);
  });
});

describe('parsePopoutBoundsFile — the actual bug fix', () => {
  it('discards a LEGACY flat {x,y,width,height} file rather than seeding every kind from it', () => {
    // This is the exact shape every install had before this change — a single
    // shared bounds. Seeding all four kinds from it would reproduce the bug
    // (TERMINAL inherits whatever huge size PROJECT/SESSION left behind) one
    // more time before self-correcting; every kind must instead fall through
    // to its own default.
    const legacy = JSON.stringify({ x: 100, y: 50, width: 1700, height: 1035 });
    expect(parsePopoutBoundsFile(legacy)).toEqual({});
  });

  it('reads a per-kind file back correctly', () => {
    const file = JSON.stringify({ terminal: B(1), project: B(2) });
    expect(parsePopoutBoundsFile(file)).toEqual({ terminal: B(1), project: B(2) });
  });

  it('a kind saved once does not affect a kind that was never saved', () => {
    // The core guarantee: TERMINAL's absence here must fall through to ITS
    // OWN default later, never PROJECT's huge saved bounds.
    const file = JSON.stringify({ project: B(9) });
    const parsed = parsePopoutBoundsFile(file);
    expect(parsed.project).toEqual(B(9));
    expect(parsed.terminal).toBeUndefined();
  });

  it('returns {} for a missing file (raw === null)', () => {
    expect(parsePopoutBoundsFile(null)).toEqual({});
  });

  it('returns {} for malformed JSON rather than throwing', () => {
    expect(parsePopoutBoundsFile('{not json')).toEqual({});
  });

  it('drops an unrecognized key rather than carrying it forward silently', () => {
    const file = JSON.stringify({ terminal: B(1), somethingElse: B(2) });
    const parsed = parsePopoutBoundsFile(file);
    expect(parsed).toEqual({ terminal: B(1) });
  });

  it('drops a per-kind entry whose value is malformed', () => {
    const file = JSON.stringify({ terminal: B(1), project: { x: 0 } });
    expect(parsePopoutBoundsFile(file)).toEqual({ terminal: B(1) });
  });

  it('never leaks a stray top-level key alongside a valid kind entry', () => {
    // This is the actual mechanism the legacy-discard behaviour rests on: the
    // parser reads ONLY the four kind-named keys. A naive implementation that
    // spread the parsed object (`{...parsed}`) instead of picking recognized
    // keys would let `x`/`y`/`width`/`height` — or anything else — leak
    // straight into the result. A hand-edited or half-migrated file mixing a
    // legacy key with a new-shape key is exactly what this guards against.
    const file = JSON.stringify({ x: 1, y: 2, width: 3, height: 4, terminal: B(1) });
    const parsed = parsePopoutBoundsFile(file);
    expect(parsed).toEqual({ terminal: B(1) });
    expect(Object.keys(parsed)).toEqual(['terminal']);
  });
});

describe('mergePopoutBounds', () => {
  it('adds a new kind without touching existing ones', () => {
    const existing = { terminal: B(1) };
    const merged = mergePopoutBounds(existing, 'project', B(2));
    expect(merged).toEqual({ terminal: B(1), project: B(2) });
  });

  it('overwrites only the saved kind', () => {
    const existing = { terminal: B(1), project: B(2) };
    const merged = mergePopoutBounds(existing, 'terminal', B(99));
    expect(merged).toEqual({ terminal: B(99), project: B(2) });
  });

  it('does not mutate the input map (pure)', () => {
    const existing = { terminal: B(1) };
    mergePopoutBounds(existing, 'project', B(2));
    expect(existing).toEqual({ terminal: B(1) });
  });
});

describe('POPOUT_DEFAULT_SIZES', () => {
  it('has a default for every kind', () => {
    for (const kind of POPOUT_KINDS) {
      expect(POPOUT_DEFAULT_SIZES[kind]).toBeDefined();
      expect(POPOUT_DEFAULT_SIZES[kind].width).toBeGreaterThan(0);
      expect(POPOUT_DEFAULT_SIZES[kind].height).toBeGreaterThan(0);
    }
  });

  it('terminal keeps its original small utility-popup default (820×560) unchanged', () => {
    // Regression guard: the terminal popup's own default was correct all
    // along — only the shared-slot leak was the bug. This must not silently
    // grow as a side effect of the split.
    expect(POPOUT_DEFAULT_SIZES.terminal).toEqual({ width: 820, height: 560 });
  });

  it('project and session get their own distinct, larger defaults', () => {
    // Before this fix they had NO default of their own — they only ever
    // inherited whatever the shared slot happened to hold.
    expect(POPOUT_DEFAULT_SIZES.project.width).toBeGreaterThan(POPOUT_DEFAULT_SIZES.terminal.width);
    expect(POPOUT_DEFAULT_SIZES.session.width).toBeGreaterThan(POPOUT_DEFAULT_SIZES.terminal.width);
  });
});
