import { describe, expect, it } from 'vitest';
import { applyOrder, classify, type ManifestEntry } from '../server/projectSync/classify.js';
import type { FileMeta, SyncEntry } from '../src/types/projectSync.js';

const file = (sha: string, extra: Partial<ManifestEntry> = {}): ManifestEntry => ({
  kind: 'file',
  size: sha.length,
  mtimeMs: 1000,
  mode: 0o644,
  sha256: sha.padEnd(64, '0'),
  ...extra,
});
const dir = (): ManifestEntry => ({ kind: 'dir', size: 0, mtimeMs: 1000, mode: 0o755 });
const link = (target: string): ManifestEntry => ({
  kind: 'symlink',
  size: 0,
  mtimeMs: 1000,
  mode: 0o777,
  linkTarget: target,
});
const m = (o: Record<string, ManifestEntry>) => new Map(Object.entries(o));
const base = (o: Record<string, ManifestEntry>) => new Map<string, FileMeta>(Object.entries(o));
const byPath = (entries: SyncEntry[]) => Object.fromEntries(entries.map((e) => [e.path, e]));
const opts = { localPlatform: 'darwin', devicePlatform: 'darwin' };

describe('classify — with a base', () => {
  const B = base({
    'a.txt': file('a'),
    'b.txt': file('b'),
    'c.txt': file('c'),
    'd.txt': file('d'),
  });
  it('maps every row of the design table', () => {
    const local = m({
      'a.txt': file('a'), // same
      'b.txt': file('b2'), // changed here
      'c.txt': file('c'), // changed on device
      // d.txt deleted here, unchanged there → delete
      'new.txt': file('n'), // added here
      'both.txt': file('x1'), // added on both, differently
    });
    const device = m({
      'a.txt': file('a'),
      'b.txt': file('b'),
      'c.txt': file('c2'),
      'd.txt': file('d'),
      'only-device.txt': file('o'), // extra
      'both.txt': file('x2'),
    });
    const e = byPath(classify(local, device, B, opts).entries);
    expect(e['a.txt'].change).toBe('same');
    expect(e['b.txt']).toMatchObject({ change: 'change', action: 'push' });
    expect(e['c.txt']).toMatchObject({ change: 'drift', action: 'review' });
    expect(e['d.txt']).toMatchObject({ change: 'delete', action: 'delete-device' });
    expect(e['new.txt']).toMatchObject({ change: 'add', action: 'push' });
    expect(e['only-device.txt']).toMatchObject({ change: 'extra', action: 'keep' });
    expect(e['both.txt']).toMatchObject({ change: 'conflict', action: 'review' });
  });
  it('deleted here but changed there is a conflict; deleted there but unchanged here is drift', () => {
    const local = m({ 'c.txt': file('c') });
    const device = m({ 'd.txt': file('d9') });
    const e = byPath(
      classify(local, device, base({ 'c.txt': file('c'), 'd.txt': file('d') }), opts).entries,
    );
    expect(e['d.txt'].change).toBe('conflict');
    expect(e['c.txt'].change).toBe('drift');
  });
  it('a mode change alone is a change', () => {
    const e = byPath(
      classify(
        m({ 'run.sh': file('r', { mode: 0o755 }) }),
        m({ 'run.sh': file('r') }),
        base({ 'run.sh': file('r') }),
        opts,
      ).entries,
    );
    expect(e['run.sh'].change).toBe('change');
  });
});

describe('classify — first run (no base)', () => {
  it('seeds identical files, asks about different ones and keeps extras', () => {
    const e = byPath(
      classify(
        m({ 'same.txt': file('s'), 'diff.txt': file('l'), 'new.txt': file('n') }),
        m({ 'same.txt': file('s'), 'diff.txt': file('r'), 'extra.txt': file('e') }),
        new Map(),
        opts,
      ).entries,
    );
    expect(e['same.txt'].change).toBe('same');
    expect(e['diff.txt']).toMatchObject({ change: 'different', action: 'review' });
    expect(e['new.txt']).toMatchObject({ change: 'add', action: 'push' });
    expect(e['extra.txt']).toMatchObject({ change: 'extra', action: 'keep' });
  });
});

describe('classify — kinds and flags', () => {
  it('blocks special files and flags credentials, outside links, live databases, native modules', () => {
    const local = m({
      fifo: { kind: 'other', size: 0, mtimeMs: 1, mode: 0o644 },
      '.env': file('secret'),
      'out.lnk': link('/etc/hosts'),
      'in.lnk': link('docs/readme.md'),
      'esc.lnk': link('../../outside'),
      'data.db': file('db'),
      'data.db-wal': file('wal'),
      'node_modules/x/build/x.node': file('bin'),
    });
    const e = byPath(
      classify(local, new Map(), new Map(), { localPlatform: 'darwin', devicePlatform: 'linux' })
        .entries,
    );
    expect(e.fifo).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(e['.env'].flags).toContain('credential');
    expect(e['.env'].action).toBe('push');
    expect(e['out.lnk'].flags).toContain('link-outside');
    expect(e['esc.lnk'].flags).toContain('link-outside');
    expect(e['in.lnk'].flags).not.toContain('link-outside');
    expect(e['data.db'].flags).toContain('live-db');
    expect(e['node_modules/x/build/x.node'].flags).toContain('native-artifact');
  });
  it('a symlink target change is a change; a kind change is a change', () => {
    const e = byPath(
      classify(
        m({ l: link('a'), k: file('f') }),
        m({ l: link('b'), k: dir() }),
        base({ l: link('b'), k: dir() }),
        opts,
      ).entries,
    );
    expect(e.l.change).toBe('change');
    expect(e.k.change).toBe('change');
  });
});

describe('classify — repositories', () => {
  const gitLocal = {
    '.git': dir(),
    '.git/HEAD': file('h', { text: 'ref: refs/heads/main\n' }),
    '.git/refs': dir(),
    '.git/refs/heads': dir(),
    '.git/refs/heads/main': file('m2', { text: 'bbbb\n' }),
    src: dir(),
    'src/a.ts': file('a'),
  };
  it('groups repo paths, reads branch and commit, and defaults to sync when only local moved', () => {
    const device = m({ ...gitLocal, '.git/refs/heads/main': file('m1', { text: 'aaaa\n' }) });
    const B = base({ ...gitLocal, '.git/refs/heads/main': file('m1') });
    const plan = classify(m(gitLocal), device, B, opts);
    const repo = plan.groups.find((g) => g.id === '.git')!;
    expect(repo).toMatchObject({ isRepo: true, decision: 'sync', state: 'local-ahead' });
    expect(repo.local).toEqual({ head: 'main', commit: 'bbbb' });
    expect(repo.device).toEqual({ head: 'main', commit: 'aaaa' });
    expect(byPath(plan.entries)['.git/refs/heads/main']).toMatchObject({
      groupId: '.git',
      action: 'push',
    });
    expect(byPath(plan.entries)['src/a.ts'].groupId).toBe('src');
  });
  it('a device-side change makes the whole repo a decision; overwrite pushes and deletes', () => {
    const device = m({ ...gitLocal, '.git/refs/heads/stale': file('s') });
    const B = base(gitLocal);
    const plan = classify(m(gitLocal), device, B, opts);
    const repo = plan.groups.find((g) => g.id === '.git')!;
    expect(repo).toMatchObject({ decision: 'review', state: 'device-changed' });
    expect(byPath(plan.entries)['.git/refs/heads/stale'].action).toBe('review');
  });
  it('a device-side .git/index rewrite alone (git status) is not a change at all', () => {
    const withIndex = { ...gitLocal, '.git/index': file('ix') };
    const device = m({ ...withIndex, '.git/index': file('ix-refreshed') });
    const plan = classify(m(withIndex), device, base(withIndex), opts);
    expect(plan.groups.find((g) => g.id === '.git')).toMatchObject({
      decision: 'sync',
      state: 'in-step',
    });
    expect(byPath(plan.entries)['.git/index']).toMatchObject({ change: 'same', action: 'skip' });
  });
  it('an index changed on both sides is pushed without asking (it is a cache)', () => {
    const withIndex = { ...gitLocal, '.git/index': file('ix') };
    const plan = classify(
      m({ ...withIndex, '.git/index': file('ix-new-commit') }),
      m({ ...withIndex, '.git/index': file('ix-refreshed') }),
      base(withIndex),
      opts,
    );
    expect(plan.groups.find((g) => g.id === '.git')).toMatchObject({
      decision: 'sync',
      state: 'local-ahead',
    });
    expect(byPath(plan.entries)['.git/index']).toMatchObject({
      change: 'conflict',
      action: 'push',
    });
  });
  it('a lock file on either side blocks the repo', () => {
    const plan = classify(
      m({ ...gitLocal, '.git/index.lock': file('l') }),
      new Map(),
      new Map(),
      opts,
    );
    const repo = plan.groups.find((g) => g.id === '.git')!;
    expect(repo).toMatchObject({ state: 'busy', decision: 'skip' });
    expect(plan.entries.filter((e) => e.groupId === '.git').every((e) => e.action === 'skip')).toBe(
      true,
    );
    expect(byPath(plan.entries)['.git/HEAD'].flags).toContain('git-busy');
  });
  it('flags a .git FILE (linked worktree)', () => {
    const e = byPath(classify(m({ '.git': file('gitdir') }), new Map(), new Map(), opts).entries);
    expect(e['.git'].flags).toContain('worktree-gitdir');
  });
});

describe('applyOrder', () => {
  it('dirs first, objects before refs, .pack before .idx, HEAD/index late, deletes last and deepest first', () => {
    const local = m({
      '.git': dir(),
      '.git/objects': dir(),
      '.git/objects/pack': dir(),
      '.git/objects/pack/p.idx': file('i'),
      '.git/objects/pack/p.pack': file('p'),
      '.git/refs': dir(),
      '.git/refs/heads': dir(),
      '.git/refs/heads/main': file('m'),
      '.git/packed-refs': file('pr'),
      '.git/HEAD': file('h'),
      '.git/index': file('ix'),
      '.git/config': file('cf'),
      'a.txt': file('a'),
    });
    const device = m({
      old: dir(),
      'old/x.txt': file('x'),
      '.git': dir(),
    });
    const B = base({ old: dir(), 'old/x.txt': file('x'), '.git': dir() });
    const plan = classify(local, device, B, opts);
    const order = applyOrder(plan.entries, device).map((o) => `${o.op}:${o.path}`);
    const at = (s: string) => order.indexOf(s);
    expect(at('put:.git/objects')).toBeLessThan(at('put:.git/objects/pack'));
    expect(at('put:.git/objects/pack/p.pack')).toBeLessThan(at('put:.git/objects/pack/p.idx'));
    expect(at('put:.git/objects/pack/p.idx')).toBeLessThan(at('put:.git/packed-refs'));
    expect(at('put:.git/packed-refs')).toBeLessThan(at('put:.git/refs/heads/main'));
    expect(at('put:.git/refs/heads/main')).toBeLessThan(at('put:.git/HEAD'));
    expect(at('put:.git/HEAD')).toBeLessThan(at('put:.git/index'));
    expect(at('put:a.txt')).toBeLessThan(at('put:.git/HEAD'));
    expect(at('delete:old/x.txt')).toBeGreaterThan(at('put:.git/index'));
    expect(at('delete:old/x.txt')).toBeLessThan(at('delete:old'));
  });
  it('replacing a device folder with a file drops the child deletes (the folder goes to trash whole)', () => {
    const plan = classify(
      m({ thing: file('f') }),
      m({ thing: dir(), 'thing/a': file('a') }),
      base({ thing: dir(), 'thing/a': file('a') }),
      opts,
    );
    const ops = applyOrder(plan.entries, m({ thing: dir(), 'thing/a': file('a') }));
    expect(ops.map((o) => `${o.op}:${o.path}`)).toEqual(['put:thing']);
  });
  it('skips entries already done and non-acting entries', () => {
    const plan = classify(m({ a: file('a'), b: file('b') }), new Map(), new Map(), opts);
    plan.entries.find((e) => e.path === 'a')!.state = 'done';
    expect(applyOrder(plan.entries, new Map()).map((o) => o.path)).toEqual(['b']);
  });
});
