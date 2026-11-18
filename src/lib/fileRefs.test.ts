// fileRefs — which bits of an agent's text may name a file or a folder (Nov 18 2026).
import { describe, it, expect } from 'vitest';
import { classifyRef, findFileRefs, messageFolders } from './fileRefs';

const refs = (text: string) => findFileRefs(text).map((t) => [t.kind, t.text]);

describe('findFileRefs', () => {
  it('finds a path with a folder and an extension, as the desktop always did', () => {
    expect(refs('see docs/plan.md and ./src/a.ts, or ../x/y.json.')).toEqual([
      ['file', 'docs/plan.md'], ['file', './src/a.ts'], ['file', '../x/y.json'],
    ]);
    expect(refs('coupon/docs/客户版-业务流程确认.md文件')).toEqual([['file', 'coupon/docs/客户版-业务流程确认.md']]);
  });

  it('finds an absolute or ~ folder (the screenshot: "Files are in /Users/…/exmouth/docs :")', () => {
    expect(refs('Files are in `/Users/kasonzhan/Documents/exmouth/docs`:')).toEqual([['dir', '/Users/kasonzhan/Documents/exmouth/docs']]);
    expect(refs('look in ~/Documents/notes/ first.')).toEqual([['dir', '~/Documents/notes/']]);
    expect(refs('It is under /Users/me/proj.')).toEqual([['dir', '/Users/me/proj']]);
  });

  it('finds a bare file name with a known extension', () => {
    expect(refs('- video-series-plan.md\n- video-series-plan.zh-CN.md')).toEqual([
      ['bare', 'video-series-plan.md'], ['bare', 'video-series-plan.zh-CN.md'],
    ]);
    expect(refs('edit package.json, then README.md.')).toEqual([['bare', 'package.json'], ['bare', 'README.md']]);
  });

  it('leaves prose alone: ratios, versions, domains, framework names, one-segment paths', () => {
    expect(refs('and/or, km/h, 10/20, v2.5, aasc.work, e.g. this, /etc, Node.js and Next.js')).toEqual([]);
  });

  it('never links inside a URL', () => {
    expect(refs('open https://example.com/a/b/plan.md or http://x.dev/docs/guide')).toEqual([]);
  });

  it('gives each token its place in the text', () => {
    const text = 'a docs/x.md b';
    const [t] = findFileRefs(text);
    expect(text.slice(t.start, t.end)).toBe('docs/x.md');
  });
});

describe('classifyRef: a whole code span or link target', () => {
  it('tells a file path, a folder path and a bare name apart', () => {
    expect(classifyRef('docs/plan.md')).toBe('file');
    expect(classifyRef('/Users/me/proj/docs/plan.md:12:3')).toBe('file');
    expect(classifyRef('/Users/me/proj/docs')).toBe('dir');
    expect(classifyRef('src/lib')).toBe('dir');
    expect(classifyRef('~/notes/')).toBe('dir');
    expect(classifyRef('plan.md')).toBe('bare');
  });

  it('is null for anything else', () => {
    for (const text of ['npm run build', 'https://a.b/c', 'Node.js', 'foo', 'a b/c.md', '', 'x.unknownext']) {
      expect(classifyRef(text), text).toBeNull();
    }
  });
});

describe('messageFolders', () => {
  it('lists the folders a message names, in order, once each', () => {
    expect(messageFolders('Files are in `/a/b/docs`:\n- x.md\nAlso ~/notes and /a/b/docs again')).toEqual(['/a/b/docs', '~/notes']);
  });

  it('adds the folder of an absolute file the message names', () => {
    expect(messageFolders('wrote /a/b/out/report.md and summary.md')).toEqual(['/a/b/out']);
  });
});
