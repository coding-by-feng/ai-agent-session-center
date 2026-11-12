import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_PROBE_ARGS,
  getClaudeModelCatalog,
  normalizeClaudeModelList,
  queryClaudeCli,
  resetClaudeModelCatalogForTests,
  type ClaudeModelOption,
} from '../server/claudeModelCatalog.js';

/** The `models` an initialize answer carried on Claude Code 2.1.322 (trimmed). */
const CLI_MODELS = [
  { value: 'default', resolvedModel: 'claude-fable-5-2', displayName: 'Default (recommended)', description: 'Fable 5.2' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'For your toughest challenges' },
  { value: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable' },
];

describe('normalizeClaudeModelList', () => {
  it('keeps CLI order, maps aliases to what they mean today, drops the Default row', () => {
    expect(normalizeClaudeModelList({ models: CLI_MODELS })).toEqual([
      { id: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
      { id: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'For your toughest challenges' },
      { id: 'claude-fable-5-1', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable' },
    ]);
  });

  it('drops duplicates and names a shell would mangle; an unsafe resolved name falls back to the ID', () => {
    expect(normalizeClaudeModelList({
      models: [
        { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' },
        { value: 'sonnet', resolvedModel: 'claude-sonnet-9' },
        { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1[1m]' },
        { value: 'haiku', resolvedModel: 'x;rm -rf' },
        null,
        { value: 42 },
      ],
    })).toEqual([
      { id: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'sonnet', description: '' },
      { id: 'haiku', resolvedModel: 'haiku', displayName: 'haiku', description: '' },
    ]);
  });

  it('is empty for a malformed answer', () => {
    expect(normalizeClaudeModelList(null)).toEqual([]);
    expect(normalizeClaudeModelList({ models: 'no' })).toEqual([]);
    expect(normalizeClaudeModelList({})).toEqual([]);
  });
});

describe('CLAUDE_PROBE_ARGS', () => {
  it('turns off every settings source and hooks, writes no session and sends no prompt', () => {
    const args = [...CLAUDE_PROBE_ARGS];
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(JSON.parse(args[args.indexOf('--settings') + 1])).toEqual({ disableAllHooks: true });
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--resume');
  });
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  written = '';
  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => { this.written += chunk.toString(); });
  }
  kill() { this.killed = true; return true; }
  answer(line: string) { this.stdout.write(`${line}\n`); }
}

const asChild = (fake: FakeChild) => fake as unknown as ChildProcessWithoutNullStreams;

const initAnswer = (requestId: string, response: unknown, subtype = 'success') => JSON.stringify({
  type: 'control_response',
  response: { subtype, request_id: requestId, response, error: subtype === 'error' ? 'nope' : undefined },
});

async function sentRequestId(fake: FakeChild): Promise<string> {
  await vi.waitFor(() => expect(fake.written).toContain('\n'));
  const sent = JSON.parse(fake.written.trim()) as { type: string; request_id: string; request: { subtype: string } };
  expect(sent.type).toBe('control_request');
  expect(sent.request.subtype).toBe('initialize');
  return sent.request_id;
}

describe('queryClaudeCli', () => {
  it('sends only initialize, skips banners and other lines, and kills the CLI once answered', async () => {
    const fake = new FakeChild();
    const result = queryClaudeCli(() => asChild(fake), 5_000);
    const id = await sentRequestId(fake);
    fake.answer('Welcome to zsh');
    fake.answer(JSON.stringify({ type: 'system', subtype: 'init' }));
    fake.answer(initAnswer('someone-else', { models: [{ value: 'opus' }] }));
    fake.answer(initAnswer(id, { models: CLI_MODELS }));
    await expect(result).resolves.toHaveLength(3);
    expect(fake.killed).toBe(true);
    expect(fake.written.trim().split('\n')).toHaveLength(1);
  });

  it('fails on an error answer, an empty list, an early exit and a timeout', async () => {
    const errored = new FakeChild();
    const p1 = queryClaudeCli(() => asChild(errored), 5_000);
    errored.answer(initAnswer(await sentRequestId(errored), null, 'error'));
    await expect(p1).rejects.toThrow(/initialize failed: nope/);

    const empty = new FakeChild();
    const p2 = queryClaudeCli(() => asChild(empty), 5_000);
    empty.answer(initAnswer(await sentRequestId(empty), { models: [] }));
    await expect(p2).rejects.toThrow(/no selectable models/);

    const exited = new FakeChild();
    const p3 = queryClaudeCli(() => asChild(exited), 5_000);
    exited.stderr.write('command not found: claude');
    await new Promise((r) => setTimeout(r, 0));
    exited.emit('exit', 127, null);
    await expect(p3).rejects.toThrow(/exited before initialize answered \(127\): command not found/);

    const silent = new FakeChild();
    await expect(queryClaudeCli(() => asChild(silent), 20)).rejects.toThrow(/timed out/);
    expect(silent.killed).toBe(true);
  });
});

describe('getClaudeModelCatalog', () => {
  afterEach(() => resetClaudeModelCatalogForTests());

  const rows: ClaudeModelOption[] = [{ id: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: '' }];

  it('asks the CLI once, then serves the cache; concurrent callers share one ask', async () => {
    const query = vi.fn(async () => rows);
    const [a, b] = await Promise.all([getClaudeModelCatalog(query), getClaudeModelCatalog(query)]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(a.source).toBe('claude-cli');
    expect(b.models).toEqual(rows);
    const c = await getClaudeModelCatalog(query);
    expect(c.source).toBe('memory-cache');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('serves the last list, marked stale, when a later ask fails; with none it throws', async () => {
    await expect(getClaudeModelCatalog(async () => { throw new Error('no claude'); })).rejects.toThrow('no claude');

    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    await getClaudeModelCatalog(async () => rows);
    clock.mockReturnValue(now + 31 * 60 * 1000);
    const stale = await getClaudeModelCatalog(async () => { throw new Error('gone'); });
    expect(stale).toMatchObject({ source: 'stale-memory-cache', stale: true, models: rows });
    clock.mockRestore();
  });
});
