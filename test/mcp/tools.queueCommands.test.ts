// test/mcp/tools.queueCommands.test.ts — Ruling 60 through the queue write tools: the window types a queued prompt, a
// chain step and the resume prompt as stored, so a central's text that starts with a slash command must be one
// command_run would run (server/mcp/commandRules.ts). A refusal reads nothing from the queue and writes nothing; a
// command that needs the session's catalog asks `GET /commands` for its CLI and folder, and text that starts with words
// asks nothing.
import { describe, expect, it } from 'vitest';
import type { CommandEntry } from '../../server/commandIndex.js';
import { standardRows, queueWorld, worker } from './queueToolFixtures.js';
import { ok } from './toolHarness.js';

const entry = (over: Partial<CommandEntry> & Pick<CommandEntry, 'name'>): CommandEntry => ({
  description: 'x',
  cli: 'claude',
  kind: 'command',
  source: 'project',
  ...over,
});

const CATALOG = [entry({ name: 'deploy' }), entry({ name: 'status', source: 'builtin' })];

const world = (opts: { cli?: boolean; catalog?: boolean } = {}) =>
  queueWorld({
    sessions: [worker('s1', { ...(opts.cli === false ? {} : { cliSource: 'claude' }), projectPath: '/a/proj' })],
    rows: standardRows(),
    // The resume prompt is a loosening change (Ruling 43): let the lock through, as for a central's own worker.
    unlocked: true,
    routes: opts.catalog === false ? {} : { 'GET /commands': ok({ entries: CATALOG }) },
  });

const catalogCalls = (w: ReturnType<typeof world>) => w.client.calls.filter((c) => c.path === '/commands');

/** Every way a central's text reaches the queue, with `text` in it. */
const writesOf = (text: string): Array<[string, Record<string, unknown>]> => [
  ['queue_add_item', { id: 's1', text }],
  ['queue_edit_item', { id: 's1', itemId: 1, text }],
  ['queue_add_step', { id: 's1', itemId: 1, chain: 'after', text }],
  ['queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text }],
  ['queue_set_automation', { id: 's1', resumePrompt: text }],
];

describe('queued text that starts with a slash command', () => {
  it.each(writesOf('/logout'))('%s refuses a command a central never runs, without asking the catalog', async (name, args) => {
    const w = world();
    const err = await w.refused(name, args);
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/never queues/);
    expect(catalogCalls(w)).toEqual([]);
    expect(w.store.calls).toEqual([]);
  });

  it.each(['/clear!', '/exit?', '/logout,', '/clear)', '/clear\u200B', '/', '/_clear', '/-clear', '/1', '/.x', '/\u0301clear', '/\u00E9xit', '/\uFF43lear', '/clear/', '/logout/a', '/clear/x', '\u00AD/clear', '\u200E/clear', '\u200B/clear', '\u2060\uFEFF /clear'].flatMap((text) => writesOf(text).map((w) => [text, ...w] as const)))(
    '%s through %s is refused: the CLI reads it as the command it nearly is',
    async (_text, name, args) => {
      const w = world();
      const err = await w.refused(name, args);
      expect(['INVALID', 'NOT_FOUND']).toContain(err.code);
      expect(w.store.writes).toEqual([]);
    },
  );

  it.each(writesOf('/Users/me/x.md is broken'))('%s queues a path as words, asking nothing', async (name, args) => {
    const w = world();
    await w.call(name, args);
    expect(catalogCalls(w)).toEqual([]);
    expect(w.store.writes).toHaveLength(1);
  });

  it.each(writesOf('\uFF0Fclear it'))('%s queues a full-width slash as words: the CLIs key on the ASCII one', async (name, args) => {
    const w = world();
    await w.call(name, args);
    expect(catalogCalls(w)).toEqual([]);
    expect(w.store.writes).toHaveLength(1);
  });

  it.each(writesOf('\\n/clear'))('%s looks past the line break the scheduler types for \\n', async (name, args) => {
    const w = world();
    expect((await w.refused(name, args)).code).toBe('INVALID');
    expect(w.store.writes).toEqual([]);
  });

  it.each(writesOf('/status'))('%s refuses a built-in of the catalog that is not compact, model or effort', async (name, args) => {
    const w = world();
    const err = await w.refused(name, args);
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/built-in/);
    expect(w.store.writes).toEqual([]);
  });

  it.each(writesOf('/logou'))('%s refuses a name the catalog does not hold exactly', async (name, args) => {
    const w = world();
    expect((await w.refused(name, args)).code).toBe('NOT_FOUND');
    expect(w.store.writes).toEqual([]);
  });

  it.each(writesOf('/deploy staging'))('%s queues a command of the session’s catalog, asked for its CLI and folder', async (name, args) => {
    const w = world();
    await w.call(name, args);
    expect(catalogCalls(w)).toEqual([
      expect.objectContaining({ method: 'GET', query: { cli: 'claude', projectPath: '/a/proj' } }),
    ]);
    expect(w.store.writes).toHaveLength(1);
  });

  it.each(writesOf('/compact keep the plan'))('%s queues a safe built-in without asking the catalog', async (name, args) => {
    const w = world();
    await w.call(name, args);
    expect(catalogCalls(w)).toEqual([]);
    expect(w.store.writes).toHaveLength(1);
  });

  it.each(writesOf('deploy it, then /status'))('%s asks nothing about text that starts with words', async (name, args) => {
    const w = world();
    await w.call(name, args);
    expect(catalogCalls(w)).toEqual([]);
    expect(w.store.writes).toHaveLength(1);
  });

  it('refuses a catalog command in a session whose agent AASC does not know, and still queues compact', async () => {
    const w = world({ cli: false });
    expect((await w.refused('queue_add_item', { id: 's1', text: '/deploy' })).code).toBe('INVALID');
    expect(catalogCalls(w)).toEqual([]);
    await w.call('queue_add_item', { id: 's1', text: '/compact' });
    expect(w.store.writes).toHaveLength(1);
  });

  it('refuses when the catalog cannot be read: nothing is queued on a guess', async () => {
    const w = world({ catalog: false });
    await w.refused('queue_add_item', { id: 's1', text: '/deploy' });
    expect(w.store.writes).toEqual([]);
  });
});

describe('run-only built-ins in queued text (Ruling P3-16)', () => {
  it.each(writesOf('/review'))('queued /review is refused: %s', async (name, args) => {
    const w = queueWorld({
      sessions: [worker('s1', { cliSource: 'codex', projectPath: '/a/proj' })],
      rows: standardRows(),
      unlocked: true,
      routes: { 'GET /commands': ok({ entries: [entry({ name: 'review', cli: 'codex', source: 'builtin' })] }) },
    });
    const err = await w.refused(name, args);
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/built-in/);
    expect(w.store.writes).toEqual([]);
  });
});
