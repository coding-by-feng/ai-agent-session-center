// terminalBookmarks.test.ts — a phone's terminal bookmarks (AASC-20): storage, and finding a line again
// after the scrollback moved under it.
import { describe, it, expect } from 'vitest';
import {
  addBookmark, removeBookmark, loadBookmarks, saveBookmarks, bookmarkLabel,
  rowAtOffset, logicalLineAt, locateBookmark, MAX_BOOKMARKS,
  type BufferLike, type TerminalBookmark,
} from './terminalBookmarks';

/** A buffer from rows; a row starting with '↪' is a soft-wrapped continuation of the one above. */
function buffer(rows: string[]): BufferLike {
  const lines = rows.map((r) => ({
    isWrapped: r.startsWith('↪'),
    translateToString: () => (r.startsWith('↪') ? r.slice(1) : r),
  }));
  return { length: lines.length, getLine: (y) => lines[y] };
}

describe('the bookmark list', () => {
  it('adds newest first, trims the text and moves a repeat to the top', () => {
    let list = addBookmark([], 4, '  ● Bash(npm test)  ', 1);
    list = addBookmark(list, 9, 'Done.', 2);
    expect(list.map((b) => b.text)).toEqual(['Done.', '● Bash(npm test)']);
    list = addBookmark(list, 4, '● Bash(npm test)', 3);
    expect(list.map((b) => b.line)).toEqual([4, 9]);
    expect(list).toHaveLength(2);
  });

  it('ignores a blank line and drops the oldest past the cap', () => {
    expect(addBookmark([], 1, '   ')).toEqual([]);
    let list: TerminalBookmark[] = [];
    for (let i = 0; i <= MAX_BOOKMARKS; i++) list = addBookmark(list, i, `line ${i}`, i);
    expect(list).toHaveLength(MAX_BOOKMARKS);
    expect(list.some((b) => b.text === 'line 0')).toBe(false);
  });

  it('removes by id without touching the input', () => {
    const list = addBookmark(addBookmark([], 1, 'a', 1), 2, 'b', 2);
    const after = removeBookmark(list, list[0].id);
    expect(after.map((b) => b.text)).toEqual(['a']);
    expect(list).toHaveLength(2);
  });

  it('round-trips through storage per terminal, and survives garbage', () => {
    const list = addBookmark([], 3, 'keep me', 5);
    saveBookmarks('term-1', list);
    expect(loadBookmarks('term-1')).toEqual(list);
    expect(loadBookmarks('term-2')).toEqual([]);
    localStorage.setItem('aasc:term-bookmarks:term-3', '{not json');
    expect(loadBookmarks('term-3')).toEqual([]);
    localStorage.setItem('aasc:term-bookmarks:term-4', JSON.stringify([{ id: 'x' }, list[0]]));
    expect(loadBookmarks('term-4')).toEqual(list);
    saveBookmarks('term-1', []);
    expect(localStorage.getItem('aasc:term-bookmarks:term-1')).toBeNull();
  });

  it('labels a long line on one row', () => {
    expect(bookmarkLabel('a\n  b   c')).toBe('a b c');
    expect(bookmarkLabel('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('reading the buffer', () => {
  it('maps a point on the screen to a row', () => {
    expect(rowAtOffset(0, 400, 20)).toBe(0);
    expect(rowAtOffset(39, 400, 20)).toBe(1);
    expect(rowAtOffset(399, 400, 20)).toBe(19);
    expect(rowAtOffset(-1, 400, 20)).toBeNull();
    expect(rowAtOffset(400, 400, 20)).toBeNull();
    expect(rowAtOffset(10, 0, 20)).toBeNull();
  });

  it('joins a soft-wrapped line and addresses it by its first row', () => {
    const buf = buffer(['$ ls', 'a very long', '↪ line that', '↪ wraps', '', 'end']);
    expect(logicalLineAt(buf, 2)).toEqual({ line: 1, text: 'a very long line that wraps' });
    expect(logicalLineAt(buf, 1)).toEqual({ line: 1, text: 'a very long line that wraps' });
    expect(logicalLineAt(buf, 4)).toBeNull();
    expect(logicalLineAt(buf, 99)).toBeNull();
  });

  it('finds a bookmark where it was, or the nearest copy after the output moved', () => {
    const buf = buffer(['x', 'Done.', 'y', 'z', 'Done.', 'w']);
    expect(locateBookmark(buf, { line: 4, text: 'Done.' })).toBe(4);
    // Two lines trimmed from the top: the old line now holds something else.
    expect(locateBookmark(buf, { line: 3, text: 'Done.' })).toBe(4);
    expect(locateBookmark(buf, { line: 2, text: 'Done.' })).toBe(1);
    expect(locateBookmark(buf, { line: 9, text: 'Done.' })).toBe(4);
  });

  it('says so when the line is gone', () => {
    expect(locateBookmark(buffer(['a', 'b']), { line: 1, text: 'cleared' })).toBeNull();
  });
});
