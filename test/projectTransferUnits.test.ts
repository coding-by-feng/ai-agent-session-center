import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanProject, linkInside, normalMode } from '../server/projectTransfer/manifest.js';
import { ExactReader, exactBytes, formatRanges, parseRanges } from '../server/projectTransfer/pack.js';
import {
  claudeProjectDirName, claudeProjectsRoot, displayPath, isGitHookPath, resolveDestination, safeRel,
} from '../server/projectTransfer/paths.js';
import { codexRolloutCwd, movePath, rewriteJsonlCwd } from '../server/projectTransfer/rekey.js';
import { itemProblem } from '../server/projectTransfer/receiver.js';
import { packsOf, formatRanges as clientFormat } from '../electron/remote/projectTransfer.js';
import type { TransferItem } from '../src/types/projectTransfer.js';

const OPTIONS = { memory: true, aasc: false, includeNodeModules: false };

describe('paths', () => {
  it('names a Claude project folder the way Claude Code does', () => {
    expect(claudeProjectDirName('/Users/k/Documents/claude/agent-manager')).toBe('-Users-k-Documents-claude-agent-manager');
    expect(claudeProjectDirName('/Users/k/.claude-mem/observer')).toBe('-Users-k--claude-mem-observer');
  });

  it('reads CLAUDE_CONFIG_DIR, with ~ expanded', () => {
    expect(claudeProjectsRoot({}, '/h')).toBe('/h/.claude/projects');
    expect(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: '~/cfg' }, '/h')).toBe('/h/cfg/projects');
  });

  it('resolves a ~/ destination and refuses hidden, secret, Library and traversal', () => {
    expect(resolveDestination('~/Documents/exmouth', '/h')).toBe('/h/Documents/exmouth');
    expect(resolveDestination('~/Documents/exmouth/', '/h')).toBe('/h/Documents/exmouth');
    for (const bad of ['/abs', '~/', '~/.ssh/x', '~/Library/x', '~/a/../b', '~/a/id_rsa', '~/a/.git', 'Documents/x', 42]) {
      expect(() => resolveDestination(bad, '/h')).toThrow();
    }
  });

  it('accepts only plain relative paths', () => {
    expect(safeRel('a/b.txt')).toBe(true);
    for (const bad of ['', '/a', 'a//b', 'a/./b', '../a', 'a\\b', 'x/.aasc-transfer-1/y']) expect(safeRel(bad)).toBe(false);
  });

  it('spots git hooks, including a submodule’s and odd letter case', () => {
    expect(isGitHookPath('.git/hooks/pre-commit')).toBe(true);
    expect(isGitHookPath('.git/modules/lib/hooks/post-checkout')).toBe(true);
    expect(isGitHookPath('.GIT/Hooks/x')).toBe(true);
    expect(isGitHookPath('src/hooks/useThing.ts')).toBe(false);
  });

  it('shows a home path as ~/…', () => {
    expect(displayPath('/h/Documents/x', '/h')).toBe('~/Documents/x');
    expect(displayPath('/elsewhere', '/h')).toBe('/elsewhere');
  });
});

describe('rekey', () => {
  it('moves the folder and folders inside it, never a sibling that shares the prefix', () => {
    expect(movePath('/a/proj', '/a/proj', '/b/p')).toBe('/b/p');
    expect(movePath('/a/proj/sub', '/a/proj', '/b/p')).toBe('/b/p/sub');
    expect(movePath('/a/project-two', '/a/proj', '/b/p')).toBe('/a/project-two');
  });

  it('rewrites cwd and payload.cwd and leaves every other line byte for byte', () => {
    const lines = [
      JSON.stringify({ type: 'user', cwd: '/a/proj', message: 'hi' }),
      'not json "cwd"',
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/a/proj/web' } }),
      JSON.stringify({ type: 'x', text: 'no folder here' }),
      '',
    ];
    const { text, changed } = rewriteJsonlCwd(lines.join('\n'), '/a/proj', '/b/p');
    const out = text.split('\n');
    expect(changed).toBe(2);
    expect(JSON.parse(out[0]).cwd).toBe('/b/p');
    expect(out[1]).toBe(lines[1]);
    expect(JSON.parse(out[2]).payload.cwd).toBe('/b/p/web');
    expect(out[3]).toBe(lines[3]);
    expect(out[4]).toBe('');
  });

  it('reads a Codex rollout’s folder from its session_meta line only', () => {
    expect(codexRolloutCwd(JSON.stringify({ type: 'session_meta', payload: { cwd: '/a' } }))).toBe('/a');
    expect(codexRolloutCwd(JSON.stringify({ type: 'turn_context', payload: { cwd: '/a' } }))).toBeNull();
    expect(codexRolloutCwd('{broken')).toBeNull();
  });
});

describe('packs', () => {
  it('formats and parses ranges the same way on both sides', () => {
    const idx = [0, 1, 2, 5, 7, 8, 9, 20];
    expect(formatRanges(idx)).toBe('0-2,5,7-9,20');
    expect(clientFormat(idx)).toBe(formatRanges(idx));
    expect(parseRanges('0-2,5,7-9,20', 21)).toEqual(idx);
  });

  it('refuses malformed, unordered, repeated or out-of-range packs', () => {
    for (const bad of ['', '3,2', '1,1', '2-1', '0-30', 'a', '1;2', '-1']) expect(parseRanges(bad, 21)).toBeNull();
  });

  it('cuts a pack by bytes and file count, a big file alone, skipping what arrived', () => {
    const items: TransferItem[] = [
      { i: 0, group: 'project', rel: 'd', kind: 'dir', size: 0, mode: 0o755, sha256: null },
      { i: 1, group: 'project', rel: 'd/a', kind: 'file', size: 10, mode: 0o644, sha256: 'a'.repeat(64) },
      { i: 2, group: 'project', rel: 'd/big', kind: 'file', size: 200 * 1024 * 1024, mode: 0o644, sha256: 'b'.repeat(64) },
      { i: 3, group: 'project', rel: 'd/c', kind: 'file', size: 10, mode: 0o644, sha256: 'c'.repeat(64) },
      { i: 4, group: 'project', rel: 'd/e', kind: 'file', size: 10, mode: 0o644, sha256: 'e'.repeat(64) },
    ];
    expect(packsOf(items, new Set())).toEqual([[1], [2], [3, 4]]);
    expect(packsOf(items, new Set([2, 3]))).toEqual([[1, 4]]);
  });

  it('sends exactly the planned size: cut short, or padded when the file shrank or vanished', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pt-pack-'));
    try {
      await writeFile(join(dir, 'f'), 'hello world');
      const read = async (path: string, size: number): Promise<Buffer> => {
        const parts: Buffer[] = [];
        for await (const b of exactBytes(path, size)) parts.push(b);
        return Buffer.concat(parts);
      };
      expect((await read(join(dir, 'f'), 5)).toString()).toBe('hello');
      expect(await read(join(dir, 'f'), 13)).toEqual(Buffer.concat([Buffer.from('hello world'), Buffer.alloc(2)]));
      expect(await read(join(dir, 'gone'), 3)).toEqual(Buffer.alloc(3));
      expect(await read(join(dir, 'f'), 0)).toEqual(Buffer.alloc(0));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reads exact counts across chunk boundaries and reports an early end', async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.from('abc');
      yield Buffer.from('defg');
    }
    const r = new ExactReader(chunks());
    const got: string[] = [];
    expect(await r.read(2, (p) => { got.push(p.toString()); })).toBe(true);
    expect(await r.read(4, (p) => { got.push(p.toString()); })).toBe(true);
    expect(got.join('')).toBe('abcdef');
    expect(await r.read(5, () => undefined)).toBe(false);
  });
});

describe('item rules on the target', () => {
  const file = (over: Partial<TransferItem>): TransferItem => ({
    i: 0, group: 'project', rel: 'a.txt', kind: 'file', size: 1, mode: 0o644, sha256: 'a'.repeat(64), ...over,
  });
  it('refuses hooks, traversal, links out, and non-files in memory folders', () => {
    expect(itemProblem(file({}), 0)).toBeNull();
    expect(itemProblem(file({ rel: '.git/hooks/pre-push' }), 0)).toMatch(/hooks/);
    expect(itemProblem(file({ rel: '../x' }), 0)).toMatch(/not allowed/);
    expect(itemProblem(file({ kind: 'symlink', sha256: null, size: 0, linkTarget: '../../etc' }), 0)).toMatch(/outside/);
    expect(itemProblem(file({ group: 'claude', kind: 'dir', sha256: null, size: 0 }), 0)).toMatch(/Only files/);
    expect(itemProblem(file({ group: 'codex', rel: 'x.jsonl' }), 0)).toMatch(/Codex/);
    expect(itemProblem(file({ group: 'aasc', rel: 'media/../x' }), 0)).not.toBeNull();
    expect(itemProblem(file({ group: 'aasc', rel: 'bundle.json' }), 0)).toBeNull();
    expect(itemProblem(file({}), 3)).toMatch(/order/);
  });
});

describe('scanProject', () => {
  let home: string;
  let root: string;
  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'pt-scan-')));
    root = join(home, 'Documents', 'proj');
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh');
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(root, 'node_modules', 'x', 'i.js'), 'x');
    await writeFile(join(root, 'src', 'a.ts'), 'export {}');
    await writeFile(join(root, '.env'), 'SECRET=1', { mode: 0o644 });
    await symlink('src/a.ts', join(root, 'inside-link'));
    await symlink('/etc/hosts', join(root, 'outside-link'));
    await mkdir(join(root, '.aasc-transfer-old'), { recursive: true });
    const claude = join(home, '.claude', 'projects', claudeProjectDirName(root));
    await mkdir(join(claude, 'memory'), { recursive: true });
    await writeFile(join(claude, 'memory', 'MEMORY.md'), '# m');
    await writeFile(join(claude, 's1.jsonl'), JSON.stringify({ cwd: root }) + '\n');
    const day = join(home, '.codex', 'sessions', '2026', '11', '22');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, 'rollout-2026-11-22T1-a_b.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: join(root, 'src') } }) + '\n');
    await writeFile(join(day, 'rollout-2026-11-22T1-other.jsonl'), JSON.stringify({ type: 'session_meta', payload: { cwd: `${root}-two` } }) + '\n');
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('carries files, inside links, memory and rollouts; leaves out hooks, node_modules, outside links and staging', async () => {
    const scan = await scanProject({ root, options: OPTIONS, env: {}, home });
    const rels = scan.entries.map((e) => `${e.group}:${e.rel}`);
    expect(rels).toEqual(expect.arrayContaining([
      'project:.git/HEAD', 'project:src/a.ts', 'project:.env', 'project:inside-link',
      'claude:memory/MEMORY.md', 'claude:s1.jsonl', 'codex:2026/11/22/rollout-2026-11-22T1-a_b.jsonl',
    ]));
    expect(rels.some((r) => r.includes('hooks'))).toBe(false);
    expect(rels.some((r) => r.includes('node_modules'))).toBe(false);
    expect(rels).not.toContain('project:outside-link');
    expect(rels.some((r) => r.includes('aasc-transfer'))).toBe(false);
    expect(rels).not.toContain('codex:2026/11/22/rollout-2026-11-22T1-other.jsonl');
    expect(scan.skipped.map((s) => s.rel)).toEqual(expect.arrayContaining(['node_modules', 'outside-link']));
    const env = scan.entries.find((e) => e.rel === '.env')!;
    expect(env.mode & 0o077).toBe(0);
    expect(scan.entries.every((e, i) => e.i === i)).toBe(true);
    expect(scan.entries.filter((e) => e.kind === 'file').every((e) => /^[0-9a-f]{64}$/.test(e.sha256 ?? ''))).toBe(true);
  });

  it('brings node_modules when asked, and no memory when not', async () => {
    const scan = await scanProject({ root, options: { memory: false, aasc: false, includeNodeModules: true }, env: {}, home });
    const rels = scan.entries.map((e) => `${e.group}:${e.rel}`);
    expect(rels).toContain('project:node_modules/x/i.js');
    expect(rels.some((r) => !r.startsWith('project:'))).toBe(false);
  });

  it('judges links and modes', () => {
    expect(linkInside('a/b', '../c')).toBe('../c');
    expect(linkInside('a/b', '../../c')).toBeNull();
    expect(linkInside('a', '/abs')).toBeNull();
    expect(normalMode('x/.env', 0o664, 'file')).toBe(0o600);
    expect(normalMode('x/run.sh', 0o777, 'file')).toBe(0o755);
  });
});
