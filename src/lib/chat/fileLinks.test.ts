// fileLinks.test.ts — which text in the phone chat names a file of this project (tap → Project tab).
import { describe, it, expect } from 'vitest';
import { chatFileLink } from './fileLinks';

const project = '/Users/me/work/app';

describe('chatFileLink', () => {
  it('takes a path relative to the project, with a folder and an extension', () => {
    expect(chatFileLink('docs/plans/plan.md', project)).toBe('/docs/plans/plan.md');
    expect(chatFileLink('./src/app.ts', project)).toBe('/src/app.ts');
    expect(chatFileLink(' reports/q3.pdf ', project)).toBe('/reports/q3.pdf');
  });

  it('takes an absolute path inside the project', () => {
    expect(chatFileLink('/Users/me/work/app/src/main.tsx', project)).toBe('/src/main.tsx');
  });

  it('drops a line (and column) suffix', () => {
    expect(chatFileLink('src/app.ts:42', project)).toBe('/src/app.ts');
    expect(chatFileLink('src/app.ts:42:7', project)).toBe('/src/app.ts');
  });

  it('refuses what it cannot place in this project', () => {
    for (const text of [
      'plan.md', // no folder: could be anywhere
      'npm test',
      'src/components', // no extension
      'https://example.com/a/b.md',
      'mailto:a@b.co',
      '~/notes/x.md',
      '/Users/me/other/x.md', // outside the project
      '/Users/me/work/app-two/x.md', // a sibling that shares the prefix
      '../other/x.md', // climbs out
      'src/../../x.md',
      '/Users/me/work/app/../secret/x.md', // absolute, then climbs out
      'a b/c.md', // whitespace: prose, not a path
      '',
      'src/app.ts\nsrc/b.ts',
    ]) {
      expect(chatFileLink(text, project), text).toBeNull();
    }
  });

  it('needs a project folder', () => {
    expect(chatFileLink('docs/plan.md', '')).toBeNull();
  });
});
