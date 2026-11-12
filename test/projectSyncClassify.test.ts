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
  it('replacing a device folder with a file deletes its files first (only an empty folder is replaced)', () => {
    const plan = classify(
      m({ thing: file('f') }),
      m({ thing: dir(), 'thing/a': file('a'), 'thing/sub': dir(), 'thing/sub/b': file('b') }),
      base({ thing: dir(), 'thing/a': file('a'), 'thing/sub': dir(), 'thing/sub/b': file('b') }),
      opts,
    );
    const ops = applyOrder(
      plan.entries,
      m({ thing: dir(), 'thing/a': file('a'), 'thing/sub': dir(), 'thing/sub/b': file('b') }),
    );
    expect(ops.map((o) => `${o.op}:${o.path}`)).toEqual([
      'delete:thing/sub/b',
      'delete:thing/a',
      'delete:thing/sub',
      'put:thing',
    ]);
  });
  it('skips entries already done and non-acting entries', () => {
    const plan = classify(m({ a: file('a'), b: file('b') }), new Map(), new Map(), opts);
    plan.entries.find((e) => e.path === 'a')!.state = 'done';
    expect(applyOrder(plan.entries, new Map()).map((o) => o.path)).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// Two-way (P2, Oct 31 2026): whichever side moved since the base wins; both = a decision.
// ---------------------------------------------------------------------------

const two = { ...opts, direction: 'two-way' as const };
const macFold = (p: string) => p.normalize('NFC').toLowerCase();

describe('classify — two-way', () => {
  const B = base({
    'a.txt': file('a'),
    'b.txt': file('b'),
    'c.txt': file('c'),
    'd.txt': file('d'),
    'e.txt': file('e'),
  });
  it('sends what moved here, gets what moved there, and asks only when both moved', () => {
    const local = m({
      'a.txt': file('a'), // same
      'b.txt': file('b2'), // changed here
      'c.txt': file('c'), // changed on the server
      // d.txt deleted here → delete on the server
      'e.txt': file('e'), // deleted on the server → delete here
      'new-here.txt': file('n'),
      'both.txt': file('x1'),
    });
    const device = m({
      'a.txt': file('a'),
      'b.txt': file('b'),
      'c.txt': file('c2'),
      'd.txt': file('d'),
      'new-there.txt': file('t'),
      'both.txt': file('x2'),
    });
    const e = byPath(classify(local, device, B, two).entries);
    expect(e['a.txt']).toMatchObject({ change: 'same', action: 'skip' });
    expect(e['b.txt']).toMatchObject({ change: 'change', action: 'push' });
    expect(e['c.txt']).toMatchObject({ change: 'drift', action: 'pull' });
    expect(e['d.txt']).toMatchObject({ change: 'delete', action: 'delete-device' });
    expect(e['e.txt']).toMatchObject({ change: 'drift', action: 'delete-local' });
    expect(e['new-here.txt']).toMatchObject({ change: 'add', action: 'push' });
    expect(e['new-there.txt']).toMatchObject({ change: 'extra', action: 'pull' });
    expect(e['both.txt']).toMatchObject({ change: 'conflict', action: 'review' });
  });
  it('first run copies single-side files over, never deletes, and asks about different ones', () => {
    const e = byPath(
      classify(
        m({ 'same.txt': file('s'), 'mine.txt': file('m'), 'diff.txt': file('d1') }),
        m({ 'same.txt': file('s'), 'theirs.txt': file('t'), 'diff.txt': file('d2') }),
        new Map(),
        two,
      ).entries,
    );
    expect(e['same.txt'].action).toBe('skip');
    expect(e['mine.txt']).toMatchObject({ change: 'add', action: 'push' });
    expect(e['theirs.txt']).toMatchObject({ change: 'extra', action: 'pull' });
    expect(e['diff.txt']).toMatchObject({ change: 'different', action: 'review' });
  });
  it('blocks a server name that folds onto a different name here, and everything under such a folder', () => {
    const e = byPath(
      classify(
        m({ 'README.md': file('r'), src: dir(), 'src/a.ts': file('a') }),
        m({
          'README.md': file('r'),
          'Readme.md': file('q'),
          src: dir(),
          'src/a.ts': file('a'),
          Src: dir(),
          'Src/b.ts': file('b'),
          'new.ts': file('n'),
        }),
        new Map(),
        { ...two, foldLocal: macFold },
      ).entries,
    );
    expect(e['Readme.md']).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(e['Readme.md'].flags).toContain('case-collision');
    expect(e['Src']).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(e['Src/b.ts']).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(e['new.ts']).toMatchObject({ change: 'extra', action: 'pull' });
  });
  it('a case-sensitive machine (no fold) blocks nothing', () => {
    const e = byPath(
      classify(
        m({ 'README.md': file('r') }),
        m({ 'README.md': file('r'), 'Readme.md': file('q') }),
        new Map(),
        two,
      ).entries,
    );
    expect(e['Readme.md']).toMatchObject({ change: 'extra', action: 'pull' });
  });
});

describe('classify — two-way repositories', () => {
  const B = base({
    '.git': dir(),
    '.git/HEAD': file('h'),
    '.git/index': file('i'),
    '.git/refs': dir(),
    '.git/refs/heads': dir(),
    '.git/refs/heads/main': file('c1'),
  });
  const repo = (extra: Record<string, ManifestEntry> = {}) =>
    m({
      '.git': dir(),
      '.git/HEAD': file('h'),
      '.git/index': file('i'),
      '.git/refs': dir(),
      '.git/refs/heads': dir(),
      '.git/refs/heads/main': file('c1'),
      ...extra,
    });
  it('only the server committed: the repository is pulled, index included', () => {
    const device = repo({
      '.git/refs/heads/main': file('c2'),
      '.git/index': file('i2'),
      '.git/objects': dir(),
    });
    const plan = classify(repo(), device, B, two);
    const g = plan.groups.find((x) => x.id === '.git')!;
    expect(g).toMatchObject({ state: 'device-ahead', decision: 'sync' });
    const e = byPath(plan.entries);
    expect(e['.git/refs/heads/main'].action).toBe('pull');
    expect(e['.git/index'].action).toBe('pull');
    expect(e['.git/objects'].action).toBe('pull');
  });
  it('only this machine committed: the repository is pushed', () => {
    const plan = classify(repo({ '.git/refs/heads/main': file('c3') }), repo(), B, two);
    expect(plan.groups.find((x) => x.id === '.git')).toMatchObject({
      state: 'local-ahead',
      decision: 'sync',
    });
    expect(byPath(plan.entries)['.git/refs/heads/main'].action).toBe('push');
  });
  it('both committed: the whole repository waits for a pick, and the index alone never counts', () => {
    const plan = classify(
      repo({ '.git/refs/heads/main': file('c3') }),
      repo({ '.git/refs/heads/main': file('c4') }),
      B,
      two,
    );
    expect(plan.groups.find((x) => x.id === '.git')).toMatchObject({
      state: 'both-changed',
      decision: 'review',
    });
    expect(byPath(plan.entries)['.git/refs/heads/main'].action).toBe('review');
    const onlyIndex = classify(
      repo({ '.git/index': file('i3') }),
      repo({ '.git/index': file('i4') }),
      B,
      two,
    );
    expect(onlyIndex.groups.find((x) => x.id === '.git')).toMatchObject({
      state: 'in-step',
      decision: 'sync',
    });
    expect(byPath(onlyIndex.entries)['.git/index'].action).toBe('skip');
  });
});

describe('applyOrder — two-way sides', () => {
  const e = (over: Partial<SyncEntry>): SyncEntry => ({
    id: over.path!,
    groupId: '',
    change: 'change',
    action: 'push',
    flags: [],
    state: 'pending',
    path: 'x',
    ...over,
  });
  it('splits the plan: the server gets pushes and deletes, this machine gets pulls and deletes', () => {
    const entries = [
      e({ path: 'up.txt', action: 'push', local: file('u') }),
      e({ path: 'down.txt', action: 'pull', device: file('d') }),
      e({ path: 'gone-there.txt', action: 'delete-device', device: file('g') }),
      e({ path: 'gone-here.txt', action: 'delete-local', local: file('h') }),
    ];
    const local = new Map<string, FileMeta>([['gone-here.txt', file('h')]]);
    const device = new Map<string, FileMeta>([['gone-there.txt', file('g')]]);
    expect(applyOrder(entries, device, 'device').map((o) => [o.op, o.path])).toEqual([
      ['put', 'up.txt'],
      ['delete', 'gone-there.txt'],
    ]);
    expect(applyOrder(entries, local, 'local').map((o) => [o.op, o.path])).toEqual([
      ['put', 'down.txt'],
      ['delete', 'gone-here.txt'],
    ]);
  });
  it('keep-both: the server copy lands here under the new name, then both files go to the server', () => {
    const entry = e({
      path: 'notes.md',
      change: 'conflict',
      action: 'keep-both',
      local: file('mine'),
      device: file('theirs'),
      copyPath: 'notes.server-20261031.md',
      copyId: 'copy-1',
    });
    const device = new Map<string, FileMeta>([['notes.md', file('theirs')]]);
    expect(applyOrder([entry], new Map(), 'local')).toEqual([
      expect.objectContaining({
        op: 'put',
        entryId: 'copy-1',
        owner: 'notes.md',
        path: 'notes.server-20261031.md',
        source: 'notes.md',
        expect: null,
      }),
    ]);
    const up = applyOrder([entry], device, 'device');
    expect(up.map((o) => [o.entryId, o.path, o.meta?.sha256?.slice(0, 6)])).toEqual([
      ['notes.md', 'notes.md', 'mine00'],
      ['copy-1', 'notes.server-20261031.md', 'theirs'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Engine review fixes (Oct 31 2026): renames by letter case, replaced folders, what the server
// may bring in (outside links, executables, .git/config).
// ---------------------------------------------------------------------------

describe('classify — two-way safety', () => {
  it('a rename on the server that only changes letter case deletes nothing here (M1)', () => {
    const e = byPath(
      classify(
        m({ 'README.md': file('r'), Docs: dir(), 'Docs/a.md': file('a') }),
        m({ 'Readme.md': file('r'), docs: dir(), 'docs/a.md': file('a') }),
        base({ 'README.md': file('r'), Docs: dir(), 'Docs/a.md': file('a') }),
        { ...two, foldLocal: macFold },
      ).entries,
    );
    for (const p of ['README.md', 'Readme.md', 'Docs', 'Docs/a.md', 'docs', 'docs/a.md'])
      expect(e[p]).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(e['README.md'].reason).toMatch(/The server has it as "Readme.md"/);
  });
  it('a rename here that only changes letter case still carries: push the new name, delete the old', () => {
    const e = byPath(
      classify(
        m({ 'Readme.md': file('r') }),
        m({ 'README.md': file('r') }),
        base({ 'README.md': file('r') }),
        { ...two, foldLocal: macFold },
      ).entries,
    );
    expect(e['Readme.md']).toMatchObject({ change: 'add', action: 'push' });
    expect(e['README.md']).toMatchObject({ change: 'delete', action: 'delete-device' });
  });
  it('a folder replaced on one side while files in it changed on the other is a conflict (H3)', () => {
    const B = base({ foo: dir(), 'foo/a.txt': file('a') });
    const serverReplaced = byPath(
      classify(
        m({ foo: dir(), 'foo/a.txt': file('a'), 'foo/new.txt': file('n') }),
        m({ foo: file('f') }),
        B,
        two,
      ).entries,
    );
    expect(serverReplaced.foo).toMatchObject({ change: 'conflict', action: 'review' });
    expect(serverReplaced.foo.reason).toMatch(/The server replaced this folder/);
    // Nothing changed inside: the replace carries as usual.
    const plain = byPath(
      classify(m({ foo: dir(), 'foo/a.txt': file('a') }), m({ foo: file('f') }), B, two).entries,
    );
    expect(plain.foo).toMatchObject({ change: 'drift', action: 'pull' });
    const hereReplaced = byPath(
      classify(m({ foo: file('f') }), m({ foo: dir(), 'foo/a.txt': file('a2') }), B, two).entries,
    );
    expect(hereReplaced.foo).toMatchObject({ change: 'conflict', action: 'review' });
    expect(hereReplaced.foo.reason).toMatch(/This computer replaced this folder/);
    // A file that became a folder of new files, on either side, carries with no question.
    const F = base({ foo: file('f') });
    const toFolder = (o: Record<string, ManifestEntry>) => ({
      ...o,
      foo: dir(),
      'foo/a.txt': file('n'),
    });
    const pulled = byPath(classify(m({ foo: file('f') }), m(toFolder({})), F, two).entries);
    expect(pulled.foo).toMatchObject({ change: 'drift', action: 'pull' });
    expect(pulled.foo.reason).toBeUndefined();
    const pushed = byPath(classify(m(toFolder({})), m({ foo: file('f') }), F, two).entries);
    expect(pushed.foo).toMatchObject({ change: 'change', action: 'push' });
    expect(pushed.foo.reason).toBeUndefined();
  });
  it('what the server may bring in: an outside link waits for a choice, an executable is flagged (M6)', () => {
    const e = byPath(
      classify(
        m({ 'tool.sh': file('t1') }),
        m({
          'tool.sh': file('t1', { mode: 0o755 }),
          'run.sh': file('r', { mode: 0o755 }),
          'hosts-link': link('/etc/hosts'),
          'local-link': link('run.sh'),
        }),
        base({ 'tool.sh': file('t1') }),
        two,
      ).entries,
    );
    expect(e['hosts-link']).toMatchObject({ change: 'extra', action: 'review' });
    expect(e['hosts-link'].flags).toContain('link-outside');
    expect(e['local-link']).toMatchObject({ action: 'pull' });
    expect(e['run.sh'].flags).toContain('executable');
    expect(e['tool.sh']).toMatchObject({ change: 'drift', action: 'pull' });
    expect(e['tool.sh'].flags).toContain('executable');
  });
  it('a .git/config the server changed holds its repository for a choice (M6)', () => {
    const repo = (config: string) =>
      m({ '.git': dir(), '.git/HEAD': file('h'), '.git/config': file(config) });
    const plan = classify(
      repo('c1'),
      repo('c2'),
      base({ '.git': dir(), '.git/HEAD': file('h'), '.git/config': file('c1') }),
      two,
    );
    expect(plan.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'device-ahead',
      decision: 'review',
    });
    expect(byPath(plan.entries)['.git/config'].flags).toContain('git-config');
    // This computer's own change to it carries as usual.
    const mine = classify(
      repo('c3'),
      repo('c1'),
      base({ '.git': dir(), '.git/HEAD': file('h'), '.git/config': file('c1') }),
      two,
    );
    expect(mine.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'local-ahead',
      decision: 'sync',
    });
  });
  it('so does a submodule’s or a worktree’s git config', () => {
    const repo = (extra: Record<string, ManifestEntry> = {}) =>
      m({ '.git': dir(), '.git/HEAD': file('h'), ...extra });
    for (const config of [
      '.git/modules/lib/config',
      '.git/modules/a/b/config',
      '.git/worktrees/w/config',
      '.git/config.worktree',
    ]) {
      const plan = classify(
        repo(),
        repo({ [config]: file('c') }),
        base({ '.git': dir(), '.git/HEAD': file('h') }),
        two,
      );
      expect(plan.groups.find((g) => g.id === '.git')).toMatchObject({ decision: 'review' });
      expect(byPath(plan.entries)[config].flags).toContain('git-config');
    }
  });
  it('a git config the server deleted waits for a choice too, as does a repository it deleted', () => {
    const here = m({
      'a.txt': file('a'),
      '.git': dir(),
      '.git/HEAD': file('h'),
      '.git/config': file('c'),
    });
    const B = base({
      'a.txt': file('a'),
      '.git': dir(),
      '.git/HEAD': file('h'),
      '.git/config': file('c'),
    });
    const plan = classify(
      here,
      m({ 'a.txt': file('a'), '.git': dir(), '.git/HEAD': file('h') }),
      B,
      two,
    );
    expect(plan.groups.find((g) => g.id === '.git')).toMatchObject({
      state: 'device-ahead',
      decision: 'review',
    });
    expect(byPath(plan.entries)['.git/config']).toMatchObject({
      change: 'drift',
      action: 'review',
    });
    expect(byPath(plan.entries)['.git/config'].flags).toContain('git-config');
    const gone = byPath(classify(here, m({ 'a.txt': file('a') }), B, two).entries);
    for (const p of ['.git', '.git/HEAD', '.git/config']) expect(gone[p].action, p).toBe('review');
  });
  it('a link inside .git from the server that leads outside is never copied here (M6)', () => {
    const B = base({ '.git': dir(), '.git/HEAD': file('h'), '.git/COMMIT_EDITMSG': file('msg') });
    const plan = classify(
      m({ '.git': dir(), '.git/HEAD': file('h'), '.git/COMMIT_EDITMSG': file('msg') }),
      m({ '.git': dir(), '.git/HEAD': file('h'), '.git/COMMIT_EDITMSG': link('/etc/hosts') }),
      B,
      two,
    );
    const e = byPath(plan.entries)['.git/COMMIT_EDITMSG'];
    expect(e).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(e.flags).toContain('link-outside');
    expect(e.reason).toMatch(/never copied here/);
  });
  it('a name a Mac reads as .git is never synced: letter case, characters HFS+ ignores', () => {
    for (const name of ['.GIT', '.Git', '.g\u200cit', '.git\ufeff']) {
      const server = byPath(
        classify(
          m({ 'a.txt': file('a') }),
          m({ 'a.txt': file('a'), [name]: dir(), [`${name}/HEAD`]: file('h') }),
          base({ 'a.txt': file('a') }),
          two,
        ).entries,
      );
      for (const p of [name, `${name}/HEAD`])
        expect(server[p]).toMatchObject({ change: 'blocked', action: 'skip' });
      expect(server[`${name}/HEAD`].reason).toMatch(/A Mac reads this name as \.git/);
      // Nor does this computer's go to the server, in a push link either.
      const here = byPath(
        classify(m({ [`sub/${name}/HEAD`]: file('h') }), m({}), base({}), opts).entries,
      );
      expect(here[`sub/${name}/HEAD`]).toMatchObject({ change: 'blocked', action: 'skip' });
    }
    // `.git` itself, and names that only contain it, are not touched by this rule.
    const plain = byPath(
      classify(m({ '.github/x.yml': file('y'), 'a.git': dir() }), m({}), base({}), opts).entries,
    );
    expect(plain['.github/x.yml'].change).not.toBe('blocked');
    expect(plain['a.git'].change).not.toBe('blocked');
  });
  it('a name a Mac reads as one of git’s config files is never synced, either way', () => {
    const repo = (extra: Record<string, ManifestEntry> = {}) =>
      m({ '.git': dir(), '.git/HEAD': file('h'), ...extra });
    const B = base({ '.git': dir(), '.git/HEAD': file('h') });
    for (const name of [
      '.git/Config',
      '.git/CONFIG',
      '.git/conf‌ig',
      '.git/config.Worktree',
      '.git/Modules/lib/config',
      '.git/worktrees/w/Config',
    ]) {
      const e = byPath(classify(repo(), repo({ [name]: file('c') }), B, two).entries)[name];
      expect(e, name).toMatchObject({ change: 'blocked', action: 'skip' });
      expect(e.reason).toMatch(/git’s config file/);
      const here = byPath(classify(repo({ [name]: file('c') }), repo(), base({}), opts).entries);
      expect(here[name], name).toMatchObject({ change: 'blocked', action: 'skip' });
    }
    // A submodule's own name keeps its letters: only the config file's spelling counts.
    const sub = byPath(
      classify(repo(), repo({ '.git/modules/Lib/config': file('c') }), B, two).entries,
    );
    expect(sub['.git/modules/Lib/config'].flags).toContain('git-config');
  });
  it('a .git file or link from the server never comes here, and the repository here stays whole', () => {
    const B = base({ '.git': dir(), '.git/HEAD': file('h'), '.git/config': file('c') });
    const here = m({ '.git': dir(), '.git/HEAD': file('h'), '.git/config': file('c') });
    // A worktree's gitdir file, a link out of the project (an earlier pass holds that), one inside.
    for (const redirect of [file('gitdir'), link('/tmp/elsewhere'), link('vendor/repo')]) {
      const plan = byPath(classify(here, m({ '.git': redirect }), B, two).entries);
      expect(plan['.git']).toMatchObject({ change: 'blocked', action: 'skip' });
      for (const p of ['.git/HEAD', '.git/config'])
        expect(plan[p], p).toMatchObject({ change: 'blocked', action: 'skip' });
    }
    expect(
      byPath(classify(here, m({ '.git': file('gitdir') }), B, two).entries)['.git'].reason,
    ).toMatch(/never copied here/);
    // First run: nothing under .git goes to the server either, and a .git file only the server
    // has is not pulled.
    const first = byPath(
      classify(
        here,
        m({ '.git': file('gitdir'), sub: dir(), 'sub/.git': file('gitdir') }),
        base({}),
        two,
      ).entries,
    );
    for (const p of ['.git', '.git/HEAD', 'sub/.git'])
      expect(first[p], p).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(first.sub.action).toBe('pull');
  });
  it('a link anywhere inside .git from the server is never copied here, even one that stays in the project', () => {
    const B = base({ '.git': dir(), '.git/HEAD': file('h') });
    const e = byPath(
      classify(
        m({ '.git': dir(), '.git/HEAD': file('h') }),
        m({ '.git': dir(), '.git/HEAD': file('h'), '.git/info': link('../tools') }),
        B,
        two,
      ).entries,
    )['.git/info'];
    expect(e).toMatchObject({ change: 'blocked', action: 'skip' });
    expect(e.reason).toMatch(/link inside \.git could point git at hooks/);
    // This computer's own link still goes to the server.
    const mine = byPath(
      classify(
        m({ '.git': dir(), '.git/HEAD': file('h'), '.git/info': link('../tools') }),
        m({ '.git': dir(), '.git/HEAD': file('h') }),
        B,
        two,
      ).entries,
    )['.git/info'];
    expect(mine.action).toBe('push');
  });
});

describe('applyOrder — deletes that must run first', () => {
  const e = (over: Partial<SyncEntry>): SyncEntry => ({
    id: over.path!,
    groupId: '',
    change: 'change',
    action: 'push',
    flags: [],
    state: 'pending',
    path: 'x',
    ...over,
  });
  it('the old spelling of a path renamed by letter case is deleted before the new one is written', () => {
    const entries = [
      e({ path: 'Docs', change: 'delete', action: 'delete-device', device: dir() }),
      e({ path: 'Docs/a.md', change: 'delete', action: 'delete-device', device: file('a') }),
      e({ path: 'docs', change: 'add', action: 'push', local: dir() }),
      e({ path: 'docs/a.md', change: 'add', action: 'push', local: file('a') }),
      e({ path: 'other.txt', change: 'delete', action: 'delete-device', device: file('o') }),
    ];
    const device = new Map<string, FileMeta>([
      ['Docs', dir()],
      ['Docs/a.md', file('a')],
      ['other.txt', file('o')],
    ]);
    expect(applyOrder(entries, device, 'device').map((o) => `${o.op}:${o.path}`)).toEqual([
      'delete:Docs/a.md',
      'delete:Docs',
      'put:docs',
      'put:docs/a.md',
      'delete:other.txt',
    ]);
  });
});
