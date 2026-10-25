// test/mcp/tools.resourceWrite.test.ts — the resources toolset's P3 writes (server/mcp/tools/resourceWrite.ts):
// `resource_rescan`, `resource_alias_add` and `resource_alias_remove`. The /api client is a fake: nothing here
// touches ~/.claude or ~/.codex, and the alias files are never written.
import { describe, expect, it, vi } from 'vitest';
import { allTools } from '../../server/mcp/registry.js';
import { envelope, fail, makeCentral, makeCtx, makeRoom, makeSession, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const toolNamed = (name: string) => allTools().find((t) => t.name === name);

const ADDED = { files: [{ path: '~/.claude/commands/rar.md', action: 'created' }] };

type Field = { safeParse(v: unknown): { success: boolean } };

describe('resource_rescan', () => {
  it('rescan posts and returns counts', async () => {
    const h = makeCtx({ routes: { 'POST /resources/scan': envelope({ state: 'scanning', progress: { phase: 'resources', done: 3, total: 40 } }) } });

    const result = await run('resource_rescan', {}, h.ctx);

    expect(h.client.calls).toEqual([{ method: 'POST', path: '/resources/scan', body: {} }]);
    expect(result.data).toEqual({ state: 'scanning', scanning: true, progress: { phase: 'resources', done: 3, total: 40 } });
    expect(result.summary).toContain('resource_list');
  });

  it('is a phase-3 write of the resources toolset, open to every kind of central', async () => {
    expect(toolNamed('resource_rescan')).toMatchObject({ toolset: 'resources', risk: 'write', phase: 3 });
    const room = makeCtx({
      central: makeCentral('room', 'r1'),
      rooms: [makeRoom('r1', ['s1'])],
      sessions: [makeSession('s1')],
      routes: { 'POST /resources/scan': envelope({ state: 'ready' }) },
    });
    expect((await run('resource_rescan', {}, room.ctx)).data).toMatchObject({ state: 'ready', scanning: false });
  });
});

describe('resource_alias_add and resource_alias_remove', () => {
  it('alias add/remove send the route’s body', async () => {
    const h = makeCtx({
      routes: {
        'POST /resources/aliases': envelope(ADDED),
        'DELETE /resources/aliases': envelope({ files: [{ path: '~/.claude/commands/rar.md', action: 'removed' }] }),
      },
    });

    const added = await run('resource_alias_add', { agent: 'claude', kind: 'command', alias: 'rar', target: 'retouch-ascii-review' }, h.ctx);
    const removed = await run('resource_alias_remove', { agent: 'claude', kind: 'command', alias: 'rar' }, h.ctx);

    expect(h.client.calls).toEqual([
      { method: 'POST', path: '/resources/aliases', body: { agent: 'claude', kind: 'command', abbr: 'rar', target: 'retouch-ascii-review' } },
      { method: 'DELETE', path: '/resources/aliases', body: { agent: 'claude', kind: 'command', abbr: 'rar' } },
    ]);
    expect(added.data).toEqual({ files: [{ path: '~/.claude/commands/rar.md', action: 'created' }] });
    expect(removed.data).toEqual({ files: [{ path: '~/.claude/commands/rar.md', action: 'removed' }] });
  });

  it('is a phase-3 write, and the alias must be 2 to 12 lowercase characters', () => {
    expect(toolNamed('resource_alias_add')).toMatchObject({ toolset: 'resources', risk: 'write', phase: 3 });
    expect(toolNamed('resource_alias_remove')).toMatchObject({ toolset: 'resources', risk: 'write', phase: 3 });
    const shape = toolNamed('resource_alias_add')?.input as unknown as Record<string, Field>;
    expect(shape.alias.safeParse('rar').success).toBe(true);
    expect(shape.alias.safeParse('r').success).toBe(false);
    expect(shape.alias.safeParse('Rar').success).toBe(false);
    expect(shape.alias.safeParse('a-very-long-alias').success).toBe(false);
    expect(shape.target.safeParse('superpowers:brainstorming').success).toBe(true);
    expect(shape.target.safeParse('../x').success).toBe(false);
    expect(shape.agent.safeParse('shared').success).toBe(false);
  });

  it('a room or project central is DENIED for aliases and calls nothing', async () => {
    for (const central of [makeCentral('room', 'r1'), makeCentral('project', '/a/proj')]) {
      const h = makeCtx({
        central,
        rooms: [makeRoom('r1', ['s1'])],
        sessions: [makeSession('s1')],
        routes: { 'POST /resources/aliases': envelope(ADDED), 'DELETE /resources/aliases': envelope(ADDED) },
      });

      const add = await runRefused('resource_alias_add', { agent: 'claude', kind: 'skill', alias: 'rar', target: 'retouch' }, h.ctx);
      const remove = await runRefused('resource_alias_remove', { agent: 'claude', kind: 'skill', alias: 'rar' }, h.ctx);

      expect(add.code).toBe('DENIED');
      expect(remove.code).toBe('DENIED');
      expect(h.client.calls).toEqual([]);
    }
  });

  it('the route’s 400 is INVALID with its words', async () => {
    const h = makeCtx({ routes: { 'POST /resources/aliases': fail(400, 'Abbreviation must be 2–12 lowercase letters, digits, "-" or "_".') } });

    const err = await runRefused('resource_alias_add', { agent: 'codex', kind: 'skill', alias: 'ab', target: 'retouch' }, h.ctx);

    expect(err.code).toBe('INVALID');
    expect(err.message).toContain('Abbreviation must be 2–12 lowercase letters');
  });

  it('a 409 (not in the catalog, shadowing, a hand-written file) is a refusal in the route’s words, not UPSTREAM', async () => {
    const h = makeCtx({ routes: { 'POST /resources/aliases': fail(409, 'That skill or command is not in the catalog. Rescan and try again.') } });

    const err = await runRefused('resource_alias_add', { agent: 'claude', kind: 'skill', alias: 'rar', target: 'nope' }, h.ctx);

    expect(err.code).toBe('INVALID');
    expect(err.message).toContain('not in the catalog');
    expect(err.hint).toContain('resource_rescan');
  });

  it('the descriptions say what the files are and who may write them', () => {
    const add = toolNamed('resource_alias_add')?.description ?? '';
    expect(add).toContain('global central only');
    expect(add).toContain('~/.claude/commands');
    expect(toolNamed('resource_alias_remove')?.description).toContain('global central only');
  });
});
