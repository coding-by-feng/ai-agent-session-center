// test/mcp/tools.resourceRemove.test.ts — the resources toolset's P5 tools (server/mcp/tools/resourceRemove.ts, Ruling
// P5-11): `resource_uninstall` (destructive: the item moves to the AASC trash, after the person allows it on the Mac) and
// `resource_restore` (write: it undoes one). Both are for a global central only. The fake /api client stands in for the
// Library routes: no test reaches the real resources or trash routes, and nothing touches ~/.claude or ~/.codex.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { changedRefusal, createConfirmBook, type ConfirmBook } from '../../server/mcp/confirm.js';
import { createEventHub } from '../../server/mcp/events.js';
import { allTools, confirmRuleViolations, type ConfirmAsk, type ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError } from '../../server/mcp/types.js';
import { TRASH_ID_RE } from '../../server/resourceUninstall.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { envelope, fail, fakeClient, makeCentral, makeCtx, makeSession, NOW, ok, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const ID = 'a1b2c3d4e5f60718';
const TRASH_ID = '1761300000000-0a1b2c3d';
const NAME = 'deploy-notes';

const toolNamed = (name: string): ToolDef => {
  const tool = allTools().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`No tool named ${name}`);
  return tool;
};

/** What `GET /resources/item/:id` answers for a skill in ~/.claude, with the fields a test names changed. */
const detailOf = (over: Record<string, unknown> = {}) => ({
  summary: {
    id: ID,
    type: 'skill',
    agent: 'claude',
    scope: 'global',
    origin: 'user',
    format: 'markdown',
    name: NAME,
    path: '~/.claude/skills/deploy-notes',
    fileCount: 2,
    bytes: 900,
    mtimeMs: 1,
    repo: { status: 'none' },
    variantIds: [],
    ...over,
  },
  findings: [],
});

const ITEM_ROUTE = `GET /resources/item/${ID}`;
const UNINSTALL_ROUTE = `POST /resources/item/${ID}/uninstall`;
const RESTORE_ROUTE = `POST /resources/trash/${TRASH_ID}/restore`;

const macOpen = (): Answer =>
  ok({ ok: true, data: { devices: [{ clientId: 'mac-1', isLocal: true, connections: 1 }], workspaceWriter: 'mac-1' } });

const books: ConfirmBook[] = [];

/** A global central calling through the real gate: runTool over a real book, the Mac's window open, /api faked by `routes`. */
function world(routes: Record<string, Answer> = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const sessions: Session[] = [
    makeSession('card-1', { terminalId: 'term-card', central: { centralId: central.centralId, kind: 'global', scopeRef: null } }),
  ];
  const t = testDeliver({ sessions: () => sessions });
  const book = createConfirmBook();
  books.push(book);
  const client = fakeClient({ 'GET /presence': macOpen(), ...routes });
  const deps: McpDeps = {
    registry,
    client: () => client,
    sessions: () => sessions,
    rooms: () => [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    deliver: t.deliver,
    confirms: book,
    tools: () => allTools(),
  };
  return {
    call: (name: string, args: Record<string, unknown>) =>
      runTool(toolNamed(name), args, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' }),
    book,
    client,
    rows: () => t.activity.listActivity().reverse(),
  };
}

const failureOf = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

const posts = (client: ReturnType<typeof fakeClient>) => client.calls.filter((c) => c.method === 'POST');
const words = (e: ToolError): string => `${e.message} ${e.hint ?? ''} ${JSON.stringify(e.data ?? null)}`;

afterEach(() => {
  for (const b of books.splice(0)) b.close();
});

describe('resource_uninstall', () => {
  it('a room or project central is DENIED and calls nothing', async () => {
    for (const central of [makeCentral('room', 'room-1'), makeCentral('project', '/a/proj')]) {
      const h = makeCtx({ central, routes: { [ITEM_ROUTE]: envelope(detailOf()), [RESTORE_ROUTE]: envelope({ name: NAME, type: 'skill', path: '~/x' }) } });

      const uninstall = await failureOf(Promise.resolve().then(() => toolNamed('resource_uninstall').confirm?.({ id: ID, confirmName: NAME }, h.ctx)));
      const uninstallRun = await failureOf(toolNamed('resource_uninstall').run({ id: ID, confirmName: NAME }, h.ctx));
      const restore = await failureOf(toolNamed('resource_restore').run({ trashId: TRASH_ID }, h.ctx));

      for (const err of [uninstall, uninstallRun, restore]) expect(err.code, central.kind).toBe('DENIED');
      expect(uninstall.message).toBe('Only a global central uninstalls a resource.');
      expect(restore.message).toBe('Only a global central restores a resource.');
      expect(h.client.calls).toEqual([]);
    }
  });

  it('a wrong confirmName is INVALID before any card and echoes neither name', async () => {
    const w = world({ [ITEM_ROUTE]: envelope(detailOf()) });

    for (const confirmName of ['Deploy-Notes', 'deploy-notes ', 'something-else']) {
      const err = await failureOf(w.call('resource_uninstall', { id: ID, confirmName }));

      expect(err).toMatchObject({ code: 'INVALID', message: 'That is not this resource’s name.' });
      expect(words(err).toLowerCase()).not.toContain('deploy-notes');
      expect(words(err)).not.toContain(confirmName.trim());
      expect(words(err)).not.toContain(ID);
    }
    expect(w.book.pending()).toEqual([]);
    expect(posts(w.client)).toEqual([]);
  });

  it('uninstall asks with the type and name, then posts the confirmName once allowed', async () => {
    const w = world({
      [ITEM_ROUTE]: envelope(detailOf()),
      [UNINSTALL_ROUTE]: envelope({ trashId: TRASH_ID, name: NAME, type: 'skill', path: '~/.claude/skills/deploy-notes' }),
    });

    const call = w.call('resource_uninstall', { id: ID, confirmName: NAME });
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    const card = w.book.pending()[0];
    expect(card).toMatchObject({
      tool: 'resource_uninstall',
      risk: 'destructive',
      summary: 'uninstall the skill deploy-notes (moved to the AASC trash; resource_restore brings it back)',
      detail: 'From ~/.claude/skills/deploy-notes',
      targetSessionId: null,
    });
    expect(posts(w.client)).toEqual([]);

    w.book.answer(card.cardId, 'allow');
    const result = (await call) as { data: Record<string, unknown>; summary: string };

    expect(posts(w.client)).toEqual([{ method: 'POST', path: `/resources/item/${ID}/uninstall`, body: { confirmName: NAME } }]);
    expect(result.data).toEqual({ trashId: TRASH_ID, name: NAME, type: 'skill', allowedByPerson: { answeredOn: 'mac' } });
    expect(result.summary).toContain(TRASH_ID);
    expect(result.summary).toContain('resource_restore');
  });

  it('a resource whose path changed after the card is CHANGED', async () => {
    let reads = 0;
    const w = world({
      [ITEM_ROUTE]: () => {
        reads += 1;
        return envelope(detailOf(reads === 1 ? {} : { path: '~/.claude/skills/somewhere-else' }));
      },
      [UNINSTALL_ROUTE]: envelope({ trashId: TRASH_ID, name: NAME, type: 'skill', path: '~/x' }),
    });

    const failed = failureOf(w.call('resource_uninstall', { id: ID, confirmName: NAME }));
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    const err = await failed;
    expect({ code: err.code, message: err.message }).toEqual({ code: changedRefusal().code, message: changedRefusal().message });
    expect(posts(w.client)).toEqual([]);
  });

  it('denied uninstalls nothing', async () => {
    const w = world({ [ITEM_ROUTE]: envelope(detailOf()), [UNINSTALL_ROUTE]: envelope({ trashId: TRASH_ID, name: NAME, type: 'skill' }) });

    const failed = failureOf(w.call('resource_uninstall', { id: ID, confirmName: NAME }));
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    w.book.answer(w.book.pending()[0].cardId, 'deny');

    expect((await failed).code).toBe('DENIED');
    expect(posts(w.client)).toEqual([]);
  });

  it('an unknown id is NOT_FOUND, and a resource the Library cannot uninstall is DENIED, both before any card', async () => {
    const w = world({ [ITEM_ROUTE]: envelope(detailOf({ origin: 'plugin', pluginName: 'tools-pack' })) });
    const missing = world({ [ITEM_ROUTE]: fail(404, 'Resource not found') });

    const plugin = await failureOf(w.call('resource_uninstall', { id: ID, confirmName: NAME }));
    const unknown = await failureOf(missing.call('resource_uninstall', { id: ID, confirmName: NAME }));

    expect(plugin.code).toBe('DENIED');
    expect(plugin.message).toContain('plugin');
    expect(words(plugin)).not.toContain(NAME);
    expect(unknown.code).toBe('NOT_FOUND');
    expect(words(unknown)).not.toContain(ID);
    expect([...w.book.pending(), ...missing.book.pending()]).toEqual([]);
    expect([...posts(w.client), ...posts(missing.client)]).toEqual([]);
  });

  it('a resource the Library will not uninstall is DENIED in fixed words per origin, naming no plugin and no link target', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ origin: 'plugin', pluginName: 'needle-plugin-9' }, 'That resource is part of a plugin: remove the plugin instead.'],
      [{ origin: 'system' }, 'That resource is bundled with the CLI: an update would only put it back.'],
      [{ origin: 'synced' }, 'That resource is synced from claude.ai: remove it there.'],
      [{ origin: 'linked', linkTarget: '/needle/link/target' }, 'That resource is a link to another folder, which owns it: remove it there.'],
      [{ origin: 'user', linkTarget: '/needle/link/target' }, 'That resource is a link: remove the link by hand if that is what the person wants.'],
      [{ type: 'hook' }, 'Only skills, commands, rules, agents and memory can be uninstalled here.'],
    ];
    for (const [over, message] of cases) {
      const w = world({ [ITEM_ROUTE]: envelope(detailOf(over)) });

      const err = await failureOf(w.call('resource_uninstall', { id: ID, confirmName: NAME }));

      expect(err, JSON.stringify(over)).toMatchObject({ code: 'DENIED', message });
      expect(words(err)).not.toContain('needle');
      expect(w.book.pending()).toEqual([]);
    }
  });

  const runRoute = async (answer: Answer) => {
    const h = makeCtx({ routes: { [UNINSTALL_ROUTE]: answer } });
    return failureOf(toolNamed('resource_uninstall').run({ id: ID, confirmName: NAME }, h.ctx));
  };

  it('the route’s 403 is DENIED (words that name nothing), its 404 NOT_FOUND', async () => {
    const denied = await runRoute(fail(403, 'Credential files are never touched'));
    const gone = await runRoute(fail(404, 'Resource not found'));

    expect(denied).toMatchObject({ code: 'DENIED', message: 'Credential files are never touched' });
    expect(gone.code).toBe('NOT_FOUND');
  });

  it('a 403 whose words could hold a name or a path is DENIED in AASC’s own words', async () => {
    const err = await runRoute(fail(403, `Part of the ${NAME} plugin — remove the plugin instead. ~/.claude/skills/${NAME}`));

    expect(err).toMatchObject({ code: 'DENIED', message: 'AASC refused to change that resource.' });
    expect(words(err)).not.toContain(NAME);
    expect(words(err)).not.toContain('~/.claude');
  });

  it('a 400 is “not its name” only for the route’s own name-mismatch words; any other 400 is a refused path', async () => {
    const mismatch = await runRoute(fail(400, 'Type the exact name to confirm'));
    const other = await runRoute(fail(400, `Path ~/.claude/skills/${NAME} is not allowed`));
    const schema = await runRoute(fail(400, 'Invalid request'));

    expect(mismatch).toMatchObject({ code: 'INVALID', message: 'That is not this resource’s name.' });
    for (const err of [other, schema]) {
      expect(err).toMatchObject({ code: 'INVALID', message: 'AASC refused that resource’s path.' });
      expect(words(err)).not.toContain(NAME);
      expect(words(err)).not.toContain('~/.claude');
    }
    expect(words(mismatch)).not.toContain(NAME);
  });

  it('a 409 is INVALID in fixed words that hold no path or name, and says to rescan', async () => {
    const changed = await runRoute(fail(409, 'Changed since the last scan — rescan'));
    const busy = await runRoute(fail(409, `Something odd at ~/.claude/skills/${NAME}`));

    for (const err of [changed, busy]) {
      expect(err).toMatchObject({ code: 'INVALID', message: 'That resource changed since the last scan.' });
      expect(err.hint).toContain('resource_rescan');
      expect(words(err)).not.toContain(NAME);
      expect(words(err)).not.toContain('~/.claude');
    }
  });

  it('a partly moved resource (copied, not fully removed) says the trash holds a complete copy and does not say call again', async () => {
    const err = await runRoute(fail(409, `Copied to the trash, but ~/.claude/skills/${NAME} could not be fully removed — the trash keeps a complete copy`));

    expect(err.code).toBe('INVALID');
    expect(err.hint).toBe('Tell the person: the AASC Library trash holds a complete copy.');
    expect(words(err)).not.toContain(NAME);
    expect(words(err)).not.toContain('~/.claude');
    expect(words(err).toLowerCase()).not.toContain('call this once more');
    expect(words(err).toLowerCase()).not.toContain('rescan');
  });

  it('the fingerprint is AASC-made and at most 200 characters, whatever the path', async () => {
    const h = makeCtx({ routes: { [ITEM_ROUTE]: envelope(detailOf({ path: `~/.claude/skills/${'d'.repeat(400)}` })) } });

    const ask = (await toolNamed('resource_uninstall').confirm?.({ id: ID, confirmName: NAME }, h.ctx)) as ConfirmAsk;

    expect(ask.fingerprint?.startsWith(`${ID}|`)).toBe(true);
    expect((ask.fingerprint ?? '').length).toBeLessThanOrEqual(200);
  });
});

describe('resource_restore', () => {
  it('restore posts and returns where it went back', async () => {
    const w = world({ [RESTORE_ROUTE]: envelope({ name: NAME, type: 'skill', path: '~/.claude/skills/deploy-notes' }) });

    const result = (await w.call('resource_restore', { trashId: TRASH_ID })) as { data: Record<string, unknown>; summary: string };

    expect(posts(w.client)).toEqual([{ method: 'POST', path: `/resources/trash/${TRASH_ID}/restore`, body: {} }]);
    expect(result.data).toEqual({ name: NAME, type: 'skill', path: '~/.claude/skills/deploy-notes' });
    expect(result.summary).toContain('~/.claude/skills/deploy-notes');
    expect(w.book.pending()).toEqual([]);
  });

  it('a folder that moved is INVALID in fixed words with no path, and an unknown trash id NOT_FOUND without repeating it', async () => {
    const moved = makeCtx({ routes: { [RESTORE_ROUTE]: fail(409, 'The folder ~/.claude/skills came from now resolves somewhere else — not restored') } });
    const unknown = makeCtx({ routes: { [RESTORE_ROUTE]: fail(404, 'Nothing in the trash under that id') } });

    const a = await failureOf(toolNamed('resource_restore').run({ trashId: TRASH_ID }, moved.ctx));
    const b = await failureOf(toolNamed('resource_restore').run({ trashId: TRASH_ID }, unknown.ctx));

    expect(a.code).toBe('INVALID');
    expect(a.message).toBe('AASC could not put that trash entry back: its place changed, or the entry is damaged.');
    expect(words(a)).not.toContain('~/.claude');
    expect(b.code).toBe('NOT_FOUND');
    expect(words(b)).not.toContain(TRASH_ID);
  });

  it('a bad trashId is INVALID by the schema, which is the route’s own pattern', () => {
    const input = z.object(toolNamed('resource_restore').input);

    expect(input.safeParse({ trashId: TRASH_ID }).success).toBe(true);
    for (const bad of ['', '1761300000000-0A1B2C3D', '176130000000-0a1b2c3d', '../../etc', `${TRASH_ID}/x`]) {
      expect(input.safeParse({ trashId: bad }).success, bad).toBe(false);
      expect(TRASH_ID_RE.test(bad), bad).toBe(false);
    }
  });
});

describe('the tools as the registry sees them', () => {
  it('uninstall is destructive with a confirm, restore a write without one; both phase 5, both say global-only', () => {
    expect(toolNamed('resource_uninstall')).toMatchObject({ toolset: 'resources', risk: 'destructive', phase: 5 });
    expect(toolNamed('resource_uninstall').confirm).toBeTypeOf('function');
    expect(toolNamed('resource_restore')).toMatchObject({ toolset: 'resources', risk: 'write', phase: 5 });
    expect(toolNamed('resource_restore').confirm).toBeUndefined();
    for (const name of ['resource_uninstall', 'resource_restore']) {
      expect(toolNamed(name).description, name).toContain('global central only');
    }
    expect(toolNamed('resource_uninstall').description).toContain('exactly');
    expect(toolNamed('resource_uninstall').description).toContain('on the Mac (NEEDS_CONFIRMATION → confirm_wait)');
    expect(confirmRuleViolations(allTools().filter((t) => t.toolset === 'resources'))).toEqual([]);
  });
});
