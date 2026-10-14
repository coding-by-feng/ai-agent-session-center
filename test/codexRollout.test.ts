import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodexRollout } from '../server/codexRollout.js';

const ID = '01a1390d-5541-7ee0-aaef-f5209247a8b3';

let root: string;

async function rollout(day: string, name: string): Promise<string> {
  const dir = join(root, 'sessions', ...day.split('/'));
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, '{}\n');
  return path;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-rollout-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('findCodexRollout', () => {
  it('finds the rollout named for the session id, in whichever day folder it began', async () => {
    await rollout('2026/10/14', 'rollout-2026-10-14T19-15-37-01a1390e-0000-7000-8000-000000000000.jsonl');
    const path = await rollout('2026/09/30', `rollout-2026-09-30T08-00-00-${ID}.jsonl`);
    expect(await findCodexRollout(ID, root)).toBe(path);
  });

  it('gives null when there is none, or nowhere to look', async () => {
    await rollout('2026/10/14', 'rollout-2026-10-14T19-15-37-01a1390e-0000-7000-8000-000000000000.jsonl');
    expect(await findCodexRollout(ID, root)).toBeNull();
    expect(await findCodexRollout(ID, join(root, 'missing'))).toBeNull();
  });

  it('refuses an id that is not a plain UUID (it becomes part of a file name)', async () => {
    await rollout('2026/10/14', 'rollout-x-..jsonl');
    expect(await findCodexRollout('..', root)).toBeNull();
    expect(await findCodexRollout('term-123', root)).toBeNull();
    expect(await findCodexRollout(`${ID}/../x`, root)).toBeNull();
  });

  it('ignores a symlink posing as the rollout', async () => {
    const target = await rollout('2026/01/01', 'elsewhere.jsonl');
    const dir = join(root, 'sessions', '2026', '10', '14');
    await mkdir(dir, { recursive: true });
    await symlink(target, join(dir, `rollout-2026-10-14T00-00-00-${ID}.jsonl`));
    expect(await findCodexRollout(ID, root)).toBeNull();
  });

  it('stops after the newest day folders it was allowed to walk', async () => {
    await rollout('2026/01/01', `rollout-2026-01-01T00-00-00-${ID}.jsonl`);
    await rollout('2026/10/14', 'rollout-other.jsonl');
    expect(await findCodexRollout(ID, root, 1)).toBeNull();
  });
});
