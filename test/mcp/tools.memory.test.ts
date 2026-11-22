// test/mcp/tools.memory.test.ts — call memory for centrals (server/mcp/tools/memory.ts, Nov 22 2026): memory_list
// (read), memory_propose (write: a proposal the person decides on later) and memory_retire (ask). Over a fake /api
// client; nothing reaches a route or a process.
import { describe, expect, it, vi } from 'vitest';
import { allTools } from '../../server/mcp/registry.js';
import { WAITS_FOR_PERSON } from '../../server/mcp/types.js';
import { envelope, fail, makeCentral, makeCtx, makeSession, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const item = (over: Record<string, unknown>) => ({
  id: 'm1', kind: 'preference', meant: 'Keep spoken answers short', heard: 'answer me in short sentences', scope: 'global',
  status: 'kept', callId: 'c', createdAt: 1, updatedAt: 1, lastUsedAt: null, supersedes: null, key: 'k', seenCount: 1, ...over,
});

const LIST = envelope({
  items: [
    item({}),
    item({ id: 'm2', kind: 'correction', meant: 'central session', heard: 'central section' }),
    item({ id: 'm3', meant: 'Open web work in a worktree', scope: 'project:/a/proj' }),
    item({ id: 'm4', meant: 'Private rule', scope: 'project:/elsewhere' }),
    item({ id: 'm5', meant: 'Not yet decided', status: 'proposed' }),
  ],
  projects: [],
});

describe('memory_list', () => {
  it('gives a central only kept items, global or of projects in its scope, fenced as the person’s data', async () => {
    const { ctx } = makeCtx({
      central: makeCentral('project', '/a/proj'),
      sessions: [makeSession('s1', { projectPath: '/a/proj' })],
      routes: { 'GET /voice/memory': LIST },
    });
    const result = await run('memory_list', {}, ctx);
    const ids = (result.data as { items: Array<{ id: string }> }).items.map((i) => i.id);
    expect(ids).toEqual(['m1', 'm2', 'm3']);
    expect(result.summary).toContain('<untrusted');
    expect(result.summary).toContain('"central section" means central session');
    expect(result.summary).not.toContain('Private rule');
    expect(result.summary).not.toContain('Not yet decided');
  });
});

describe('memory_propose', () => {
  it('sends a proposal and says the person decides after the call', async () => {
    const { ctx, client } = makeCtx({ routes: { 'POST /voice/memory': envelope({ item: item({ id: 'm9', status: 'proposed' }) }) } });
    const result = await run('memory_propose', { kind: 'preference', heard: 'answer me in short sentences', meant: 'Keep spoken answers short' }, ctx);
    expect(client.calls.find((c) => c.method === 'POST')?.body).toEqual({
      kind: 'preference', heard: 'answer me in short sentences', meant: 'Keep spoken answers short', scope: 'global',
    });
    expect(result.summary).toMatch(/after the call/i);
    expect((result.data as { status: string }).status).toBe('proposed');
  });

  it('refuses a project outside the central’s scope before any call', async () => {
    const { ctx, client } = makeCtx({ central: makeCentral('project', '/a/proj'), sessions: [makeSession('s1', { projectPath: '/a/proj' })] });
    const err = await runRefused('memory_propose', { kind: 'preference', heard: 'x y z', meant: 'm', project: '/elsewhere' }, ctx);
    expect(err.code).toBe('INVALID');
    expect(client.calls).toEqual([]);
  });

  it('turns the route’s 409 and 422 into the rule the central must follow', async () => {
    const outside = makeCtx({ routes: { 'POST /voice/memory': fail(409, 'Only during a call') } });
    expect((await runRefused('memory_propose', { kind: 'preference', heard: 'a b c', meant: 'm' }, outside.ctx)).hint).toMatch(/during a call/i);
    const notSaid = makeCtx({ routes: { 'POST /voice/memory': fail(422, 'heard must be the person’s own words') } });
    expect((await runRefused('memory_propose', { kind: 'preference', heard: 'a b c', meant: 'm' }, notSaid.ctx)).hint).toMatch(/person’s own words/);
  });
});

describe('memory_retire', () => {
  it('waits for the person, and asks about the item by its meaning', async () => {
    const tool = allTools().find((t) => t.name === 'memory_retire');
    expect(tool && WAITS_FOR_PERSON.has(tool.risk)).toBe(true);
    const { ctx } = makeCtx({ routes: { 'GET /voice/memory': LIST } });
    const ask = await tool?.confirm?.({ id: 'm1' }, ctx);
    expect(ask?.detail).toContain('Keep spoken answers short');
  });

  it('forgets a kept item in scope; one out of scope is not found', async () => {
    const { ctx, client } = makeCtx({
      central: makeCentral('project', '/a/proj'),
      sessions: [makeSession('s1', { projectPath: '/a/proj' })],
      routes: { 'GET /voice/memory': LIST, 'POST /voice/memory/m3': envelope({ item: item({ id: 'm3', status: 'retired' }) }) },
    });
    await run('memory_retire', { id: 'm3' }, ctx);
    expect(client.calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/voice/memory/m3', body: { action: 'retire' } });
    expect((await runRefused('memory_retire', { id: 'm4' }, ctx)).code).toBe('NOT_FOUND');
  });
});
