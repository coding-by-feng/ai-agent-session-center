// test/mcp/tools.deletes.test.ts — the four P5 deletes (server/mcp/tools/deletes.ts, Ruling P5-12): `snippet_delete`,
// `history_delete`, `note_delete` and `agenda_delete`. Each is destructive and always asks; each reads its item first,
// so an unknown one is NOT_FOUND before any card, and the card's detail is the item's own text. The fingerprint is the
// item's id and when it last changed, so an item changed after the card is deleted only after the person is asked
// again. The gate is driven through runTool over a real confirmation book, /api over a fake client. Nothing reaches a
// route, the database or a process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry, type MintInput } from '../../server/mcp/centrals.js';
import { changedRefusal, createConfirmBook, type ConfirmBook } from '../../server/mcp/confirm.js';
import { createEventHub } from '../../server/mcp/events.js';
import { allTools, confirmRuleViolations, type ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput, projectInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { fail, fakeClient, makeSession, NOW, ok, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const toolNamed = (name: string): ToolDef => {
  const tool = allTools().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`No tool named ${name}`);
  return tool;
};

const macOpen = (): Answer =>
  ok({ ok: true, data: { devices: [{ clientId: 'mac-1', isLocal: true, connections: 1 }], workspaceWriter: 'mac-1' } });

/** An id no list holds: no refusal may repeat it. */
const NEEDLE = 'zz-needle-424242';
const NEEDLE_NUMBER = 424_242;

const SNIPPETS = {
  success: true,
  revision: 5,
  snippets: [{ id: 3, label: 'Review', text: 'Review the diff before you merge', useCount: 2, lastUsedAt: null, createdAt: 10 }],
};

const ENDED_ID = 'old-session-1';
const historyDetail = (over: Record<string, unknown> = {}) => ({
  session: {
    id: ENDED_ID,
    title: 'Fix the login bug',
    summary: 'Found the token expiry check',
    project_path: '/a/proj',
    project_name: 'proj',
    status: 'ended',
    last_activity_at: 5_000,
    total_prompts: 4,
    ...over,
  },
  prompts: [],
  responses: [],
  tool_calls: [],
  events: [],
  notes: [{ id: 1, text: 'a note', created_at: 1, updated_at: 1 }],
});

const notesOf = (updatedAt = 20) => [
  { id: 7, session_id: 'w1', text: '## Plan\nShip on Friday', created_at: 10, updated_at: updatedAt },
  { id: 8, session_id: 'w1', text: 'second note', created_at: 11, updated_at: 11 },
];

const TASK_ID = '1f6e0c3a-9d2b-4b8e-8f00-5a1d2c3b4e5f';
const agendaOf = (updatedAt = '2026-10-20T10:00:00.000Z') => ({
  ok: true,
  data: [
    {
      id: TASK_ID,
      title: 'Renew the domain',
      description: 'Before the end of the month',
      priority: 'high',
      tags: [],
      completed: false,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt,
    },
  ],
});

/** Every route the four tools read, answering the standard items. */
const readRoutes = (): Record<string, Answer> => ({
  'GET /snippets': ok(SNIPPETS),
  [`GET /db/sessions/${ENDED_ID}`]: ok(historyDetail()),
  'GET /db/sessions/w1/notes': ok(notesOf()),
  'GET /agenda': ok(agendaOf()),
});

const deleteRoutes = (): Record<string, Answer> => ({
  'DELETE /snippets/3': ok({ success: true, revision: 6, snippets: [] }),
  [`DELETE /db/sessions/${ENDED_ID}`]: ok({ ok: true }),
  'DELETE /db/notes/7': ok({ ok: true }),
  [`DELETE /agenda/${TASK_ID}`]: ok({ ok: true }),
});

/** The four tools, each with arguments that name its standard item, the route that deletes it, and the card's text. */
const CASES: Array<{ name: string; args: Record<string, unknown>; route: string; detail: string; target: string | null }> = [
  { name: 'snippet_delete', args: { id: 3 }, route: '/snippets/3', detail: 'Review the diff before you merge', target: null },
  { name: 'history_delete', args: { id: ENDED_ID }, route: `/db/sessions/${ENDED_ID}`, detail: 'Fix the login bug\nFound the token expiry check', target: ENDED_ID },
  { name: 'note_delete', args: { sessionId: 'w1', noteId: 7 }, route: '/db/notes/7', detail: '## Plan\nShip on Friday', target: 'w1' },
  { name: 'agenda_delete', args: { id: TASK_ID }, route: `/agenda/${TASK_ID}`, detail: 'Renew the domain\nBefore the end of the month', target: null },
];

/** One route's answer, as a route function gives it. */
type Reply = ReturnType<typeof ok>;

const books: ConfirmBook[] = [];

interface WorldOptions {
  input?: MintInput;
  routes?: Record<string, Answer>;
  sessions?: Session[];
}

/** A central calling through the real gate: runTool over a real book, the Mac's window open, /api faked. */
function world(o: WorldOptions = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(o.input ?? globalInput());
  const card = makeSession('card-1', {
    terminalId: 'term-card',
    projectPath: '/a/proj',
    central: { centralId: central.centralId, kind: central.kind, scopeRef: central.scopeRef },
  });
  const sessions: Session[] = [card, ...(o.sessions ?? [makeSession('w1', { terminalId: 'term-w1', status: 'idle' })])];
  const t = testDeliver({ sessions: () => sessions });
  const book = createConfirmBook();
  books.push(book);
  const client = fakeClient({ 'GET /presence': macOpen(), ...readRoutes(), ...deleteRoutes(), ...o.routes });
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

const deletes = (client: ReturnType<typeof fakeClient>) => client.calls.filter((c) => c.method === 'DELETE');
const words = (e: ToolError): string => `${e.message} ${e.hint ?? ''} ${JSON.stringify(e.data ?? null)}`;

afterEach(() => {
  for (const b of books.splice(0)) b.close();
});

describe('the four deletes', () => {
  it('each asks with the item’s text as detail, then deletes once allowed', async () => {
    for (const c of CASES) {
      const w = world();

      const call = w.call(c.name, c.args);
      await vi.waitFor(() => expect(w.book.pending(), c.name).toHaveLength(1));
      const card = w.book.pending()[0];
      expect(card, c.name).toMatchObject({ tool: c.name, risk: 'destructive', detail: c.detail, targetSessionId: c.target });
      expect(deletes(w.client), c.name).toEqual([]);

      w.book.answer(card.cardId, 'allow');
      const result = (await call) as { data: Record<string, unknown> };

      expect(deletes(w.client), c.name).toEqual([{ method: 'DELETE', path: c.route }]);
      expect(result.data.deleted, c.name).toBe(true);
    }
  });

  it('the summaries are AASC’s words only: no title, name or text of the item (they reach the activity rows)', async () => {
    const summaries: string[] = [];
    for (const c of CASES) {
      const w = world();
      const failed = failureOf(w.call(c.name, c.args));
      await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
      summaries.push(w.book.pending()[0].summary);
      w.book.answer(w.book.pending()[0].cardId, 'deny');
      await failed;
      const rows = JSON.stringify(w.rows());
      for (const text of ['Review the diff', 'Fix the login bug', 'Ship on Friday', 'Renew the domain']) expect(rows, c.name).not.toContain(text);
    }
    expect(summaries).toEqual([
      'delete saved prompt #3 from your library (it cannot be undone)',
      'delete session old-sess from the history, with its notes and their media (it cannot be undone)',
      'delete note 7 of session w1 (it cannot be undone)',
      'delete agenda task 1f6e0c3a (it cannot be undone)',
    ]);
  });

  it('an unknown id is NOT_FOUND before any card', async () => {
    const unknown: Array<[string, Record<string, unknown>, Record<string, Answer>]> = [
      ['snippet_delete', { id: NEEDLE_NUMBER }, {}],
      ['history_delete', { id: NEEDLE }, { [`GET /db/sessions/${NEEDLE}`]: fail(404, 'Session not found') }],
      ['note_delete', { sessionId: 'w1', noteId: NEEDLE_NUMBER }, {}],
      ['agenda_delete', { id: NEEDLE }, {}],
    ];
    for (const [name, args, routes] of unknown) {
      const w = world({ routes });

      const err = await failureOf(w.call(name, args));

      expect(err.code, name).toBe('NOT_FOUND');
      expect(w.book.pending(), name).toEqual([]);
      expect(deletes(w.client), name).toEqual([]);
    }
  });

  it('no refusal repeats the id passed', async () => {
    const refusals: ToolError[] = [];
    const w = world({ routes: { [`GET /db/sessions/${NEEDLE}`]: fail(404, 'Session not found') } });
    refusals.push(await failureOf(w.call('snippet_delete', { id: NEEDLE_NUMBER })));
    refusals.push(await failureOf(w.call('history_delete', { id: NEEDLE })));
    refusals.push(await failureOf(w.call('note_delete', { sessionId: 'w1', noteId: NEEDLE_NUMBER })));
    refusals.push(await failureOf(w.call('note_delete', { sessionId: NEEDLE, noteId: 7 })));
    refusals.push(await failureOf(w.call('agenda_delete', { id: NEEDLE })));
    const live = world({ sessions: [makeSession(NEEDLE, { terminalId: 'term-n', status: 'idle' })] });
    refusals.push(await failureOf(live.call('history_delete', { id: NEEDLE })));

    for (const err of refusals) {
      expect(words(err)).not.toContain(NEEDLE);
      expect(words(err)).not.toContain(String(NEEDLE_NUMBER));
    }
  });

  it('denied deletes nothing', async () => {
    for (const c of CASES) {
      const w = world();
      const failed = failureOf(w.call(c.name, c.args));
      await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
      w.book.answer(w.book.pending()[0].cardId, 'deny');

      expect((await failed).code, c.name).toBe('DENIED');
      expect(deletes(w.client), c.name).toEqual([]);
    }
  });

  it('an item changed after the card is not deleted: the person is asked about it as it is now', async () => {
    const changed: Array<[string, Record<string, unknown>, string, () => Reply]> = [
      ['note_delete', { sessionId: 'w1', noteId: 7 }, 'GET /db/sessions/w1/notes', () => ok(notesOf(99))],
      ['agenda_delete', { id: TASK_ID }, 'GET /agenda', () => ok(agendaOf('2026-10-24T09:00:00.000Z'))],
      ['snippet_delete', { id: 3 }, 'GET /snippets', () => ok({ ...SNIPPETS, snippets: [{ ...SNIPPETS.snippets[0], text: 'Delete the branch' }] })],
      ['history_delete', { id: ENDED_ID }, `GET /db/sessions/${ENDED_ID}`, () => ok(historyDetail({ last_activity_at: 9_000 }))],
      // The card shows the title and summary: a rewrite of either, with the same activity time, is a change too.
      ['history_delete', { id: ENDED_ID }, `GET /db/sessions/${ENDED_ID}`, () => ok(historyDetail({ title: 'Delete the whole repo' }))],
      ['history_delete', { id: ENDED_ID }, `GET /db/sessions/${ENDED_ID}`, () => ok(historyDetail({ summary: 'Nothing worth keeping' }))],
    ];
    for (const [name, args, route, later] of changed) {
      let reads = 0;
      const first = readRoutes()[route];
      const w = world({
        routes: {
          [route]: (call): Reply => {
            reads += 1;
            if (reads > 1) return later();
            return typeof first === 'function' ? first(call) : first;
          },
        },
      });

      const failed = failureOf(w.call(name, args));
      await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
      w.book.answer(w.book.pending()[0].cardId, 'allow');

      expect((await failed).message, name).toBe(changedRefusal().message);
      expect(deletes(w.client), name).toEqual([]);
    }
  });
});

describe('history_delete', () => {
  it('history_delete refuses a live session and names session_close', async () => {
    const live = makeSession(ENDED_ID, { terminalId: 'term-old', status: 'idle' });
    const w = world({ sessions: [live] });

    const err = await failureOf(w.call('history_delete', { id: ENDED_ID }));

    expect(err).toMatchObject({ code: 'INVALID', message: 'That session is still open: close it first (session_close).' });
    expect(w.book.pending()).toEqual([]);
    expect(deletes(w.client)).toEqual([]);
  });

  it('a session the store holds as ended is a history row like any other', async () => {
    const w = world({ sessions: [makeSession(ENDED_ID, { status: 'ended', endedAt: 4_000 })] });

    const call = w.call('history_delete', { id: ENDED_ID });
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    await call;
    expect(deletes(w.client)).toEqual([{ method: 'DELETE', path: `/db/sessions/${ENDED_ID}` }]);
  });

  it('history_delete’s summary says notes and their media go too', async () => {
    const w = world();

    const failed = failureOf(w.call('history_delete', { id: ENDED_ID }));
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    const card = w.book.pending()[0];
    expect(card.summary).toContain('with its notes and their media');
    expect(card.summary).toContain('cannot be undone');
    w.book.answer(card.cardId, 'deny');
    await failed;
    expect(toolNamed('history_delete').description).toContain('notes and their media');
  });

  it('a project central cannot delete a history row outside its folder', async () => {
    const outside = `GET /db/sessions/${ENDED_ID}`;
    const w = world({
      input: projectInput('/a/proj'),
      routes: { [outside]: ok(historyDetail({ project_path: '/b/other' })) },
    });

    const err = await failureOf(w.call('history_delete', { id: ENDED_ID }));

    expect(err.code).toBe('NOT_IN_SCOPE');
    expect(w.book.pending()).toEqual([]);
    expect(deletes(w.client)).toEqual([]);

    // One in its folder asks, as for a global central.
    const inside = world({ input: projectInput('/a/proj') });
    const call = failureOf(inside.call('history_delete', { id: ENDED_ID }));
    await vi.waitFor(() => expect(inside.book.pending()).toHaveLength(1));
    inside.book.answer(inside.book.pending()[0].cardId, 'deny');
    expect((await call).code).toBe('DENIED');
  });
});

describe('note_delete', () => {
  it('note_delete refuses a note that is not that session’s', async () => {
    const w = world({
      sessions: [makeSession('w1', { terminalId: 'term-w1' }), makeSession('w2', { terminalId: 'term-w2' })],
      routes: { 'GET /db/sessions/w2/notes': ok([{ id: 9, session_id: 'w2', text: 'w2’s own', created_at: 1, updated_at: 1 }]) },
    });

    const err = await failureOf(w.call('note_delete', { sessionId: 'w2', noteId: 7 }));

    expect(err).toMatchObject({ code: 'NOT_FOUND', message: 'That session has no note with that id.' });
    expect(w.book.pending()).toEqual([]);
    expect(deletes(w.client)).toEqual([]);
  });

  it('a session outside the central’s scope is NOT_IN_SCOPE before its notes are read', async () => {
    const w = world({ input: projectInput('/a/proj'), sessions: [makeSession('w1', { terminalId: 'term-w1', projectPath: '/b/other' })] });

    const err = await failureOf(w.call('note_delete', { sessionId: 'w1', noteId: 7 }));

    expect(err.code).toBe('NOT_IN_SCOPE');
    expect(w.client.calls.filter((c) => c.path.includes('/notes'))).toEqual([]);
  });
});

describe('agenda_delete and snippet_delete', () => {
  it('a task gone by the time it runs is NOT_FOUND', async () => {
    const w = world({ routes: { [`DELETE /agenda/${TASK_ID}`]: fail(404, 'Task not found') } });

    const failed = failureOf(w.call('agenda_delete', { id: TASK_ID }));
    await vi.waitFor(() => expect(w.book.pending()).toHaveLength(1));
    w.book.answer(w.book.pending()[0].cardId, 'allow');

    expect((await failed).code).toBe('NOT_FOUND');
  });
});

describe('the tools as the registry sees them', () => {
  it('are destructive phase-5 tools of their own toolsets, each with a confirm and the rule in its description', () => {
    const toolsets: Record<string, string> = { snippet_delete: 'snippets', history_delete: 'history', note_delete: 'notes', agenda_delete: 'agenda' };
    for (const [name, toolset] of Object.entries(toolsets)) {
      const tool = toolNamed(name);
      expect(tool, name).toMatchObject({ toolset, risk: 'destructive', phase: 5 });
      expect(tool.confirm, name).toBeTypeOf('function');
      expect(tool.description, name).toContain('Always waits for the person to allow it');
      expect(tool.description, name).toContain('cannot be undone');
    }
    expect(toolNamed('history_delete').description).toContain('session_close');
    expect(confirmRuleViolations(Object.keys(toolsets).map(toolNamed))).toEqual([]);
  });
});
