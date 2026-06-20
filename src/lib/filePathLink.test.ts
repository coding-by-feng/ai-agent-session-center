import { describe, it, expect } from 'vitest';
import {
  createFilePathRegex,
  mapLineColumns,
  type FilePathBufferLine,
} from './filePathLink';

const matchAll = (text: string): string[] =>
  [...text.matchAll(createFilePathRegex())].map((m) => m[0]);

describe('createFilePathRegex', () => {
  it('matches ASCII paths (unchanged from the original behaviour)', () => {
    expect(matchAll('see src/components/Foo.tsx for details')).toEqual([
      'src/components/Foo.tsx',
    ]);
  });

  it('matches non-English (CJK) paths — the reported bug', () => {
    expect(
      matchAll('⏺ Write(coupon-redeem/docs/客户版-业务流程确认.md)'),
    ).toEqual(['coupon-redeem/docs/客户版-业务流程确认.md']);
  });

  it('matches Cyrillic and accented-Latin path segments', () => {
    expect(matchAll('русский/путь/документ.txt here')).toEqual([
      'русский/путь/документ.txt',
    ]);
  });

  it('honours ./ and ../ prefixes alongside Unicode segments', () => {
    expect(matchAll('edited ./docs/客户版.md and ../a/b/файл.ts')).toEqual([
      './docs/客户版.md',
      '../a/b/файл.ts',
    ]);
  });

  it('stops at the ASCII extension and does not swallow trailing CJK text', () => {
    // No space between filename and following prose — extension must remain ASCII.
    expect(matchAll('edit docs/客户版.md文件 here')).toEqual(['docs/客户版.md']);
  });

  it('excludes trailing full-width punctuation', () => {
    expect(matchAll('trailing docs/说明.md。end')).toEqual(['docs/说明.md']);
  });

  it('handles multi-dot filenames with Unicode segments', () => {
    expect(matchAll('archive a/b/名字.tar.gz x')).toEqual(['a/b/名字.tar.gz']);
  });

  it('requires at least one slash (bare word.doc in prose is not a path)', () => {
    expect(matchAll('this is a word.doc reference')).toEqual([]);
    expect(matchAll('no slash here 这是2.0版本')).toEqual([]);
  });

  it('returns a fresh regex each call (no shared lastIndex state)', () => {
    const a = createFilePathRegex();
    const b = createFilePathRegex();
    expect(a).not.toBe(b);
    a.exec('a/b.ts'); // advances a.lastIndex only
    expect(b.lastIndex).toBe(0);
  });
});

describe('mapLineColumns', () => {
  // Build a fake xterm buffer line from [chars, width] tuples.
  const fakeLine = (cells: Array<[string, number]>): FilePathBufferLine => ({
    length: cells.length,
    getCell: (x) =>
      cells[x] && {
        getChars: () => cells[x][0],
        getWidth: () => cells[x][1],
      },
  });

  it('maps narrow ASCII cells 1:1', () => {
    const { text, startCol, endCol } = mapLineColumns(
      fakeLine([
        ['a', 1],
        ['b', 1],
        ['c', 1],
      ]),
    );
    expect(text).toBe('abc');
    expect(startCol).toEqual([0, 1, 2]);
    expect(endCol).toEqual([0, 1, 2]);
  });

  it('accounts for wide (CJK) cells and their placeholder', () => {
    // "ab客d": 客 is width-2, followed by a zero-width placeholder cell.
    const { text, startCol, endCol } = mapLineColumns(
      fakeLine([
        ['a', 1],
        ['b', 1],
        ['客', 2],
        ['', 0],
        ['d', 1],
      ]),
    );
    expect(text).toBe('ab客d');
    expect(startCol).toEqual([0, 1, 2, 4]);
    expect(endCol).toEqual([0, 1, 3, 4]); // 客 spans columns 2-3; d at column 4
  });

  it('renders empty cells as spaces (matching translateToString)', () => {
    const { text } = mapLineColumns(
      fakeLine([
        ['a', 1],
        ['', 1],
        ['b', 1],
      ]),
    );
    expect(text).toBe('a b');
  });
});
