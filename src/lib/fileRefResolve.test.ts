// fileRefResolve — a folder or a bare file name becomes a link only once the Mac says it exists (Nov 18 2026).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetFileRefCacheForTest, resolveFileRef } from './fileRefResolve';

const PROJECT = '/Users/me/proj';
type Hit = { kind: 'file' | 'dir' };
let disk: Record<string, Hit>;
let index: Record<string, string[]>;
let calls: string[];

beforeEach(() => {
  resetFileRefCacheForTest();
  disk = {};
  index = {};
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = new URL(String(input), 'http://x');
    calls.push(`${url.pathname}?${url.searchParams.get('path') ?? url.searchParams.get('q')}`);
    if (url.pathname === '/api/files/resolve') {
      const path = url.searchParams.get('path')!;
      const hit = disk[path];
      return hit
        ? new Response(JSON.stringify({ absolute: path.replace(/^~/, '/Users/me'), kind: hit.kind }), { status: 200 })
        : new Response(JSON.stringify({ error: 'Path does not exist' }), { status: 404 });
    }
    if (url.pathname === '/api/files/search') {
      const results = (index[url.searchParams.get('q')!] ?? []).map((path) => ({ path, name: path.split('/').pop(), type: 'file' }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    return new Response('{}', { status: 500 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveFileRef: a folder', () => {
  it('is found when the Mac has it, absolute or relative to the project', async () => {
    disk['/Users/me/other/docs'] = { kind: 'dir' };
    disk[`${PROJECT}/src/lib`] = { kind: 'dir' };
    expect(await resolveFileRef('/Users/me/other/docs', 'dir', { projectPath: PROJECT })).toEqual({ kind: 'dir', absolute: '/Users/me/other/docs' });
    expect(await resolveFileRef('src/lib/', 'dir', { projectPath: PROJECT })).toEqual({ kind: 'dir', absolute: `${PROJECT}/src/lib` });
  });

  it('is null when there is no such path (a branch name, a regex)', async () => {
    expect(await resolveFileRef('feat/terminal-editions', 'dir', { projectPath: PROJECT })).toBeNull();
  });

  it('expands ~ through the Mac', async () => {
    disk['~/notes'] = { kind: 'dir' };
    expect(await resolveFileRef('~/notes', 'dir', { projectPath: PROJECT })).toEqual({ kind: 'dir', absolute: '/Users/me/notes' });
  });
});

describe('resolveFileRef: a bare name', () => {
  it('looks first in the folders the message named, in order', async () => {
    disk['/Users/me/exmouth/docs/plan.md'] = { kind: 'file' };
    const found = await resolveFileRef('plan.md', 'bare', { projectPath: PROJECT, folders: ['/Users/me/none', '/Users/me/exmouth/docs'] });
    expect(found).toEqual({ kind: 'file', absolute: '/Users/me/exmouth/docs/plan.md' });
    expect(calls.some((c) => c.startsWith('/api/files/search'))).toBe(false);
  });

  it('then at the project root', async () => {
    disk[`${PROJECT}/package.json`] = { kind: 'file' };
    expect(await resolveFileRef('package.json', 'bare', { projectPath: PROJECT })).toEqual({ kind: 'file', absolute: `${PROJECT}/package.json` });
  });

  it('then in the project file list, only when exactly one file has that name', async () => {
    index['plan.md'] = ['docs/plan.md', 'docs/old-plan.md'];
    expect(await resolveFileRef('plan.md', 'bare', { projectPath: PROJECT })).toEqual({ kind: 'file', absolute: `${PROJECT}/docs/plan.md` });
    index['index.ts'] = ['src/a/index.ts', 'src/b/index.ts'];
    expect(await resolveFileRef('index.ts', 'bare', { projectPath: PROJECT })).toBeNull();
    expect(await resolveFileRef('nowhere.md', 'bare', { projectPath: PROJECT })).toBeNull();
  });

  it('asks once for the same name', async () => {
    disk[`${PROJECT}/README.md`] = { kind: 'file' };
    await resolveFileRef('README.md', 'bare', { projectPath: PROJECT });
    const before = calls.length;
    await resolveFileRef('README.md', 'bare', { projectPath: PROJECT });
    expect(calls.length).toBe(before);
  });

  it('does not remember a failure to reach the Mac', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    expect(await resolveFileRef('README.md', 'bare', { projectPath: PROJECT })).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ absolute: `${PROJECT}/README.md`, kind: 'file' }), { status: 200 })));
    expect(await resolveFileRef('README.md', 'bare', { projectPath: PROJECT })).toEqual({ kind: 'file', absolute: `${PROJECT}/README.md` });
  });
});
