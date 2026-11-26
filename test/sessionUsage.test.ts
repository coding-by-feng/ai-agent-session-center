import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  foldClaudeUsage,
  readSessionUsage,
  readStatusLineCost,
  resetSessionUsageCache,
  totalsOf,
} from '../server/chat/sessionUsage.js';

const reply = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'assistant', requestId: `req-${id}`, message: { id, model: 'claude-opus-5-5', usage }, ...extra });

const U = (input: number, cacheWrite: number, cacheRead: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: cacheWrite,
  cache_read_input_tokens: cacheRead,
  output_tokens: output,
});

describe('foldClaudeUsage', () => {
  it('counts each API reply once, even when the transcript splits it into several lines', () => {
    const byId = foldClaudeUsage([
      reply('m1', U(10, 100, 0, 5)),
      reply('m1', U(10, 100, 0, 40)), // same reply, a later content block: last wins
      reply('m2', U(3, 20, 110, 7)),
    ]);
    expect(totalsOf(byId)).toEqual({ steps: 2, input: 13, cacheWrite: 120, cacheRead: 110, output: 47 });
  });

  it('ignores user lines, synthetic replies, junk and lines without usage', () => {
    const byId = foldClaudeUsage([
      JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      reply('s', U(0, 0, 0, 0), { message: { id: 's', model: '<synthetic>', usage: U(0, 0, 0, 0) } }),
      JSON.stringify({ type: 'assistant', message: { id: 'nousage' } }),
      '{not json',
      '',
      reply('m1', U(1, 2, 3, 4)),
    ]);
    expect(totalsOf(byId)).toEqual({ steps: 1, input: 1, cacheWrite: 2, cacheRead: 3, output: 4 });
  });

  it('falls back to the request id when a reply has no message id', () => {
    const line = JSON.stringify({ type: 'assistant', requestId: 'r9', message: { usage: U(1, 0, 0, 1) } });
    expect(totalsOf(foldClaudeUsage([line, line])).steps).toBe(1);
  });

  it('is null-safe on an empty transcript', () => {
    expect(totalsOf(foldClaudeUsage([]))).toBeNull();
  });
});

describe('readSessionUsage', () => {
  let dir: string;
  beforeEach(async () => {
    resetSessionUsageCache();
    dir = await mkdtemp(join(tmpdir(), 'aasc-usage-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a transcript, then only what was appended since', async () => {
    const path = join(dir, 't.jsonl');
    await writeFile(path, `${reply('m1', U(1, 10, 0, 2))}\n`);
    expect(await readSessionUsage(path)).toEqual({ steps: 1, input: 1, cacheWrite: 10, cacheRead: 0, output: 2 });

    // A half-written line is left for the next read.
    const next = reply('m2', U(2, 0, 11, 3));
    await appendFile(path, next.slice(0, 20));
    expect((await readSessionUsage(path))?.steps).toBe(1);
    await appendFile(path, `${next.slice(20)}\n`);
    expect(await readSessionUsage(path)).toEqual({ steps: 2, input: 3, cacheWrite: 10, cacheRead: 11, output: 5 });
  });

  it('starts over when the file shrank (rewritten)', async () => {
    const path = join(dir, 't.jsonl');
    await writeFile(path, `${reply('m1', U(100, 0, 0, 1))}\n${reply('m2', U(100, 0, 0, 1))}\n`);
    expect((await readSessionUsage(path))?.steps).toBe(2);
    await writeFile(path, `${reply('m3', U(5, 0, 0, 1))}\n`);
    expect(await readSessionUsage(path)).toEqual({ steps: 1, input: 5, cacheWrite: 0, cacheRead: 0, output: 1 });
  });

  it('is null for a missing file or one with no replies', async () => {
    expect(await readSessionUsage(join(dir, 'missing.jsonl'))).toBeNull();
    const path = join(dir, 'empty.jsonl');
    await writeFile(path, `${JSON.stringify({ type: 'user' })}\n`);
    expect(await readSessionUsage(path)).toBeNull();
  });
});

describe('readStatusLineCost', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aasc-runtime-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the tap's cost for that session", async () => {
    await writeFile(join(dir, 'abc-123.json'), JSON.stringify({ ts: 1, cost: { usd: 14.08 } }));
    expect(await readStatusLineCost('abc-123', dir)).toBe(14.08);
  });

  it('is undefined for no snapshot, no cost, a bad value, a bad key or a symlink', async () => {
    await writeFile(join(dir, 'nocost.json'), JSON.stringify({ ts: 1 }));
    await writeFile(join(dir, 'neg.json'), JSON.stringify({ ts: 1, cost: { usd: -1 } }));
    await mkdir(join(dir, 'real'));
    await writeFile(join(dir, 'real', 'x.json'), JSON.stringify({ ts: 1, cost: { usd: 3 } }));
    await symlink(join(dir, 'real', 'x.json'), join(dir, 'link.json'));
    expect(await readStatusLineCost('missing', dir)).toBeUndefined();
    expect(await readStatusLineCost('nocost', dir)).toBeUndefined();
    expect(await readStatusLineCost('neg', dir)).toBeUndefined();
    expect(await readStatusLineCost('../etc/passwd', dir)).toBeUndefined();
    expect(await readStatusLineCost('link', dir)).toBeUndefined();
  });
});
