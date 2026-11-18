import { describe, it, expect } from 'vitest';
import {
  createFilePathRegex,
  linkTarget,
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

// Nov 17 2026: a printed absolute path was sent to the file routes as-is, which read every path as
// relative to the session's folder: `/Users/…/x.md` became `<root>/Users/…/x.md`, so all three
// chooser actions found nothing. linkTarget turns a link into the (root, path) the routes understand.
describe('linkTarget', () => {
  const R = '/Users/me/aasc/public/website';

  it('keeps a relative path relative to the session folder', () => {
    expect(linkTarget('src/a.md', R)).toEqual({ projectPath: R, filePath: 'src/a.md' });
    expect(linkTarget('./src/a.md', R)).toEqual({ projectPath: R, filePath: 'src/a.md' });
  });

  it('makes an absolute path inside the session folder relative to it', () => {
    expect(linkTarget(`${R}/src/a.md`, R)).toEqual({ projectPath: R, filePath: 'src/a.md' });
    expect(linkTarget(`${R}/src/a.md`, `${R}/`)).toEqual({ projectPath: `${R}/`, filePath: 'src/a.md' });
  });

  it('roots an absolute path outside the session folder at the file’s own folder', () => {
    expect(linkTarget('/Users/me/aasc/private/docs/plan.md', R)).toEqual({
      projectPath: '/Users/me/aasc/private/docs',
      filePath: 'plan.md',
      hostProjectPath: R,
    });
  });

  it('is not fooled by a sibling folder that shares the prefix', () => {
    expect(linkTarget('/Users/me/aasc/public/website-old/x.md', R)).toEqual({
      projectPath: '/Users/me/aasc/public/website-old',
      filePath: 'x.md',
      hostProjectPath: R,
    });
  });

  it('with no session folder, an absolute path still has a root; a relative one stays as it was', () => {
    expect(linkTarget('/Users/me/docs/x.md', '')).toEqual({ projectPath: '/Users/me/docs', filePath: 'x.md', hostProjectPath: '' });
    expect(linkTarget('src/a.md', '')).toEqual({ projectPath: '', filePath: 'src/a.md' });
  });
});

// Nov 18 2026: a folder link, and a path the Mac confirmed (fileRefResolve).
describe('dirLinkTarget / resolvedLinkTarget', () => {
  it('roots a folder at itself, hosted by the session folder', async () => {
    const { dirLinkTarget } = await import('./filePathLink');
    expect(dirLinkTarget('/Users/me/exmouth/docs/', '/Users/me/proj')).toEqual({
      projectPath: '/Users/me/exmouth/docs', filePath: '/', hostProjectPath: '/Users/me/proj', kind: 'dir',
    });
  });

  it('sends a confirmed file through linkTarget and a confirmed folder through dirLinkTarget', async () => {
    const { resolvedLinkTarget } = await import('./filePathLink');
    expect(resolvedLinkTarget({ kind: 'file', absolute: '/Users/me/proj/docs/a.md' }, '/Users/me/proj')).toEqual({ projectPath: '/Users/me/proj', filePath: 'docs/a.md' });
    expect(resolvedLinkTarget({ kind: 'dir', absolute: '/Users/me/proj/docs' }, '/Users/me/proj')).toMatchObject({ kind: 'dir', projectPath: '/Users/me/proj/docs' });
  });
});

