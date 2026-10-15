// diffRows.test.ts — how a diff hunk is drawn (AASC-44): rows with old/new line
// numbers (none when the transcript didn't record where), the sticky header's
// words, and the reference "Comment" puts into the composer draft.
import { describe, it, expect } from 'vitest';
import type { DiffHunk } from '@/types/chat';
import { commentReference, hunkHeader, hunkRows, positionsKnown } from './diffRows';

const known: DiffHunk = { oldStart: 40, oldLines: 3, newStart: 40, newLines: 3, lines: [' <svg>', '-  <rect y="10.5" />', '+  <rect y="7" />', ' </svg>'] };
const unknown: DiffHunk = { oldStart: 0, oldLines: 1, newStart: 0, newLines: 1, lines: ['-a', '+b'] };

describe('hunkRows', () => {
  it('numbers context, removed and added lines like a unified diff', () => {
    expect(hunkRows(known)).toEqual([
      { kind: 'context', text: '<svg>', oldNo: 40, newNo: 40 },
      { kind: 'del', text: '  <rect y="10.5" />', oldNo: 41, newNo: null },
      { kind: 'add', text: '  <rect y="7" />', oldNo: null, newNo: 41 },
      { kind: 'context', text: '</svg>', oldNo: 42, newNo: 42 },
    ]);
  });

  it('leaves the numbers out when the position is unknown', () => {
    expect(hunkRows(unknown).every((r) => r.oldNo === null && r.newNo === null)).toBe(true);
  });

  it('numbers a whole new file from line 1', () => {
    const created: DiffHunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] };
    expect(hunkRows(created).map((r) => r.newNo)).toEqual([1, 2]);
  });
});

describe('hunkHeader', () => {
  it('reads like a unified diff header with real minus signs', () => {
    expect(hunkHeader(known, 0)).toBe('@@ −40,3 +40,3 @@');
  });

  it('names an unplaced hunk by its order', () => {
    expect(hunkHeader(unknown, 1)).toBe('Change 2');
    expect(positionsKnown([unknown])).toBe(false);
    expect(positionsKnown([known, unknown])).toBe(true);
  });
});

describe('commentReference', () => {
  it('points at the new line number', () => {
    expect(commentReference('src/ui/icons.tsx', { kind: 'add', text: 'x', oldNo: null, newNo: 41 })).toBe('src/ui/icons.tsx:41 — ');
    expect(commentReference('a.ts', { kind: 'context', text: 'x', oldNo: 9, newNo: 10 })).toBe('a.ts:10 — ');
  });

  it('says when the line was removed', () => {
    expect(commentReference('a.ts', { kind: 'del', text: 'x', oldNo: 41, newNo: null })).toBe('a.ts:41 (removed line) — ');
  });

  it('quotes the line when its number is unknown', () => {
    expect(commentReference('a.ts', { kind: 'add', text: '   const answer = 42;', oldNo: null, newNo: null }))
      .toBe('a.ts “const answer = 42;” — ');
    const long = 'x'.repeat(100);
    expect(commentReference('a.ts', { kind: 'add', text: long, oldNo: null, newNo: null })).toBe(`a.ts “${'x'.repeat(60)}…” — `);
  });
});
