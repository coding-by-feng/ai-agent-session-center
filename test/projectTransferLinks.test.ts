/**
 * Links a paired computer sends must never let later writes land outside the project
 * (security review, Nov 27 2026): a chain like s→. , l→s/.. , m→l/.. , n→m/.. passes a lexical
 * check but resolves to the folder above, and a file `n/.zshenv` then lands in the user's home.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkInside } from '../server/projectTransfer/manifest.js';
import { createReceiver, validateItems } from '../server/projectTransfer/receiver.js';
import type { TransferItem } from '../src/types/projectTransfer.js';

const COMPUTER = { id: 'computer-a', label: 'Mac A' };
const PAYLOAD = 'echo pwned\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let home: string;

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'pt-links-')));
  await mkdir(join(home, 'code'), { recursive: true });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function receiver() {
  return createReceiver({
    home, env: {},
    isAllowed: () => true,
    allow: () => undefined,
    onRequestsChanged: () => undefined,
    freeBytes: async () => 10 * 1024 ** 3,
  });
}

const link = (i: number, rel: string, linkTarget: string): TransferItem => ({
  i, group: 'project', rel, kind: 'symlink', size: 0, mode: 0o777, sha256: null, linkTarget,
});
const file = (i: number, rel: string, text = PAYLOAD): TransferItem => ({
  i, group: 'project', rel, kind: 'file', size: Buffer.byteLength(text), mode: 0o644, sha256: sha(text),
});

async function* bytes(text: string) {
  yield Buffer.from(text);
}

const body = (id: string, items: TransferItem[]) => ({
  id, projectName: 'proj', destination: '~/code/proj', sourceRoot: '/Users/other/code/proj', items,
});

describe('links stay inside the project', () => {
  it('accepts a target that climbs only at its start and not past the project', () => {
    expect(linkInside('a/b', '../c')).toBe('../c');
    expect(linkInside('a/b/c', '../../d/e')).toBe('../../d/e');
    expect(linkInside('x', 'y/z')).toBe('y/z');
    expect(linkInside('a/b', '../../c')).toBeNull();
  });

  it('refuses dot parts and a climb after a name, which only look inside', () => {
    expect(linkInside('s', '.')).toBeNull();
    expect(linkInside('l', 's/..')).toBeNull();
    expect(linkInside('a/b', '../c/../d')).toBeNull();
    expect(linkInside('a/b', './c')).toBeNull();
    expect(linkInside('a/b', 'c//d')).toBeNull();
    expect(linkInside('a/b', 'c/')).toBeNull();
  });

  it('refuses any item under a link, whatever its letter case', () => {
    expect(() => validateItems([link(0, 'N', 'y'), file(1, 'n/.zshenv')])).toThrow(/under a link/);
    expect(() => validateItems([file(0, 'n/.zshenv'), link(1, 'n', 'y')])).toThrow(/under a link/);
    expect(() => validateItems([link(0, 'a/b', 'c'), link(1, 'A/B/d', 'e')])).toThrow(/under a link/);
    expect(() => validateItems([link(0, 'n', 'y'), file(1, 'n2')])).not.toThrow();
  });

  it('a link chain cannot put a file in the home folder (reviewer exploit 1)', async () => {
    const r = receiver();
    const id = randomUUID();
    const items = [
      link(0, 's', '.'), link(1, 'l', 's/..'), link(2, 'm', 'l/..'), link(3, 'n', 'm/..'),
      link(4, 'n/.zshenv', 'code/proj/payload.sh'), file(5, 'payload.sh'),
    ];
    const began = await r.begin(body(id, items), COMPUTER).then(() => true, () => false);
    if (began) {
      await r.receivePack(id, COMPUTER.id, '5', bytes(PAYLOAD)).catch(() => undefined);
      await r.commit(id, COMPUTER.id).catch(() => undefined);
    }
    expect(existsSync(join(home, '.zshenv'))).toBe(false);
    expect(began).toBe(false);
  });

  it('a failed commit cannot leave links that a resend writes through (reviewer exploit 2)', async () => {
    await writeFile(join(home, '.zshrc'), 'mine\n');
    const r = receiver();
    const id = randomUUID();
    const items = [
      link(0, 's', '.'), link(1, 'l', 's/..'), link(2, 'm', 'l/..'), link(3, 'n', 'm/..'),
      link(4, 'm/proj', 'nowhere'),
    ];
    await r.begin(body(id, items), COMPUTER).catch(() => undefined);
    await r.commit(id, COMPUTER.id).catch(() => undefined);
    await r.begin(body(id, [...items, file(5, 'n/.zshrc')]), COMPUTER).catch(() => undefined);
    await r.receivePack(id, COMPUTER.id, '5', bytes(PAYLOAD)).catch(() => undefined);
    expect(await readFile(join(home, '.zshrc'), 'utf8')).toBe('mine\n');
    expect((await lstat(join(home, '.zshrc'))).isSymbolicLink()).toBe(false);
  });

  it('a legitimate inside link still arrives', async () => {
    const r = receiver();
    const id = randomUUID();
    const items = [file(0, 'src/a.ts', 'a\n'), link(1, 'docs/a', '../src/a.ts')];
    await r.begin(body(id, items), COMPUTER);
    await r.receivePack(id, COMPUTER.id, '0', bytes('a\n'));
    await r.commit(id, COMPUTER.id);
    expect(await readFile(join(home, 'code', 'proj', 'docs', 'a'), 'utf8')).toBe('a\n');
  });
});
