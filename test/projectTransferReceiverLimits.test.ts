/**
 * The target keeps a bounded amount in memory (security review, Nov 27 2026): finished transfers
 * keep a small record only, a computer has at most three receiving at once, and an idle receiving
 * transfer leaves memory but resumes from its stage on disk.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exactBytes } from '../server/projectTransfer/pack.js';
import { claudeProjectDirName } from '../server/projectTransfer/paths.js';
import { createReceiver } from '../server/projectTransfer/receiver.js';
import { holdsAnotherFolder } from '../server/projectTransfer/sender.js';
import type { TransferItem } from '../src/types/projectTransfer.js';

const COMPUTER = { id: 'computer-a', label: 'Mac A' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const file = (i: number, rel: string, text: string): TransferItem => ({
  i, group: 'project', rel, kind: 'file', size: Buffer.byteLength(text), mode: 0o644, sha256: sha(text),
});
async function* bytes(text: string) {
  yield Buffer.from(text);
}

let home: string;
let clock: number;
let allowed: boolean;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pt-limits-')));
  await mkdir(join(home, 'code'), { recursive: true });
  clock = 1_000_000;
  allowed = true;
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function receiver() {
  return createReceiver({
    home, env: {}, now: () => clock,
    isAllowed: () => allowed,
    allow: () => undefined,
    onRequestsChanged: () => undefined,
    freeBytes: async () => 10 * 1024 ** 3,
  });
}

const body = (id: string, name: string, items: TransferItem[]) => ({
  id, projectName: name, destination: `~/code/${name}`, sourceRoot: `/Users/other/code/${name}`, items,
});

describe('receiver limits', () => {
  it('lets one computer have three transfers receiving, not a fourth', async () => {
    const r = receiver();
    for (const n of ['a', 'b', 'c']) await r.begin(body(randomUUID(), n, [file(0, 'x', 'x')]), COMPUTER);
    await expect(r.begin(body(randomUUID(), 'd', [file(0, 'x', 'x')]), COMPUTER)).rejects.toMatchObject({ code: 'too_many_transfers' });
  });

  it('a declined or lapsed request still answers its status, as a small record', async () => {
    allowed = false;
    const r = receiver();
    const lapsed = randomUUID();
    const declined = randomUUID();
    await r.begin(body(lapsed, 'a', [file(0, 'x', 'x')]), COMPUTER);
    await r.begin(body(declined, 'b', [file(0, 'x', 'x')]), COMPUTER);
    await r.answer(declined, false);
    clock += 16 * 60_000;
    expect((await r.getStatus(lapsed, COMPUTER.id)).state).toBe('declined');
    expect((await r.getStatus(declined, COMPUTER.id)).state).toBe('declined');
    expect(r.requests()).toEqual([]);
  });

  it('an idle receiving transfer leaves memory and resumes from its stage', async () => {
    const r = receiver();
    const id = randomUUID();
    const items = [file(0, 'a.txt', 'a\n'), file(1, 'b.txt', 'b\n')];
    await r.begin(body(id, 'p', items), COMPUTER);
    await r.receivePack(id, COMPUTER.id, '0', bytes('a\n'));
    clock += 7 * 60 * 60_000;
    await expect(r.getStatus(id, COMPUTER.id)).rejects.toThrow();
    const resumed = await r.begin(body(id, 'p', items), COMPUTER);
    expect(resumed.have).toEqual([0]);
  });
});

describe('review follow-ups', () => {
  it('a Decline sticks: the same id cannot ask again', async () => {
    allowed = false;
    const r = receiver();
    const id = randomUUID();
    await r.begin(body(id, 'a', [file(0, 'x', 'x')]), COMPUTER);
    await r.answer(id, false);
    await expect(r.begin(body(id, 'a', [file(0, 'x', 'x')]), COMPUTER)).rejects.toMatchObject({ code: 'declined' });
    expect(r.requests()).toEqual([]);
  });

  it('streams a big transcript, re-keying every line across chunk edges and keeping its last line as it was', async () => {
    const r = receiver();
    const id = randomUUID();
    const src = '/Users/other/code/p';
    const lines = Array.from({ length: 30_000 }, (_, n) => JSON.stringify({ n, cwd: n % 2 ? src : `${src}/sub`, pad: 'x'.repeat(40) }));
    const text = `${lines.join('\n')}\n{"tail":true,"cwd":"${src}"}`;
    const memory: TransferItem = { i: 1, group: 'claude', rel: 'sess.jsonl', kind: 'file', size: Buffer.byteLength(text), mode: 0o600, sha256: sha(text) };
    await r.begin(body(id, 'p', [file(0, 'a.txt', 'a'), memory]), COMPUTER);
    await r.receivePack(id, COMPUTER.id, '0-1', (async function* () { yield Buffer.from('a'); yield Buffer.from(text); })());
    await r.commit(id, COMPUTER.id);
    const dest = join(home, 'code', 'p');
    const out = await readFile(join(home, '.claude', 'projects', claudeProjectDirName(dest), 'sess.jsonl'), 'utf8');
    expect(out).toBe(text.split(src).join(dest));
  });

  it('never adds memory to a Claude folder another project here already uses', async () => {
    const r = receiver();
    const id = randomUUID();
    const dest = join(home, 'code', 'work-app');
    const shared = join(home, '.claude', 'projects', claudeProjectDirName(dest));
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'theirs.jsonl'), '{}\n');
    const memory: TransferItem = { i: 1, group: 'claude', rel: 'memory/MEMORY.md', kind: 'file', size: 2, mode: 0o600, sha256: sha('m\n') };
    await r.begin({ ...body(id, 'work-app', [file(0, 'a.txt', 'a'), memory]) }, COMPUTER);
    await r.receivePack(id, COMPUTER.id, '0-1', (async function* () { yield Buffer.from('am\n'); })());
    const result = await r.commit(id, COMPUTER.id);
    expect(result.warnings.join(' ')).toMatch(/Claude memory did not come across/);
    expect(existsSync(join(shared, 'memory', 'MEMORY.md'))).toBe(false);
  });

  it('a Move keeps a Claude folder that also holds another folder’s transcripts', async () => {
    const dir = join(home, 'shared');
    await mkdir(dir);
    await writeFile(join(dir, 'a.jsonl'), `{"type":"x"}\n{"cwd":"${home}/work/app"}\n`);
    expect(await holdsAnotherFolder(dir, `${home}/work/app`)).toBe(false);
    await writeFile(join(dir, 'b.jsonl'), `{"cwd":"${home}/work-app/src"}\n`);
    expect(await holdsAnotherFolder(dir, `${home}/work/app`)).toBe(true);
    expect(await holdsAnotherFolder(join(home, 'missing'), '/x')).toBe(false);
  });

  it('never sends the bytes behind a file swapped for a link after the scan', async () => {
    await writeFile(join(home, 'secret'), 'KEY');
    await symlink(join(home, 'secret'), join(home, 'swapped'));
    const chunks: Buffer[] = [];
    for await (const c of exactBytes(join(home, 'swapped'), 3)) chunks.push(c);
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(3));
    await writeFile(join(home, 'plain'), 'abc');
    const plain: Buffer[] = [];
    for await (const c of exactBytes(join(home, 'plain'), 3)) plain.push(c);
    expect(Buffer.concat(plain).toString()).toBe('abc');
  });
});
