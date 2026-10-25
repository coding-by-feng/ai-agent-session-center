// test/mcp/deliverWiring.test.ts — the server's own P2 runtime (server/mcp/deliverWiring.ts): which live pieces it
// is built from. The session store, the terminals, the database and the prompt route's submitter are mocked (no test
// may reach a real terminal or process); presence, the hook signals and the book of central Escs are the real,
// process-local modules.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { fakeClient, makeSession, ok } from './toolHarness.js';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  debugJson: vi.fn(),
  isDebug: false,
}));
vi.mock('../../server/logger.js', () => ({ default: log }));

const live = vi.hoisted(() => ({
  sessions: new Map<string, unknown>(),
  aliases: new Map<string, string>(),
  exitListeners: new Set<(terminalId: string) => void>(),
  opsTerminals: new Set<string>(),
  db: null as unknown,
  interrupts: [] as Array<{ sessionId: string; terminalId: string }>,
  /** Terminals whose foreground program is a shell now, not the agent. */
  away: new Set<string>(),
  queues: new Map<string, unknown>(),
  queueWrites: [] as Array<{ sessionId: string; automation: unknown; origin: string }>,
}));

vi.mock('../../server/sessionStore.js', () => ({
  getSession: (id: string) => {
    const resolved = live.aliases.get(id) ?? id;
    const s = live.sessions.get(resolved);
    return s ? { ...(s as object) } : null;
  },
  resolveSessionId: (id: string) => {
    const resolved = live.aliases.get(id) ?? id;
    return live.sessions.has(resolved) ? resolved : null;
  },
  getAllSessions: () => Object.fromEntries(live.sessions),
}));
vi.mock('../../server/sshManager.js', () => ({
  onTerminalExit: (listener: (terminalId: string) => void) => {
    live.exitListeners.add(listener);
    return () => live.exitListeners.delete(listener);
  },
  isOpsTerminal: (terminalId: string) => live.opsTerminals.has(terminalId),
  getForegroundProcess: (terminalId: string) => (live.away.has(terminalId) ? 'zsh' : 'claude'),
}));
vi.mock('../../server/db.js', () => ({
  dbHandle: () => live.db,
  getSessionQueue: (sessionId: string) => live.queues.get(sessionId) ?? null,
}));
// The router's dependencies without the disk: a home above the workers' folder, every folder there, no links.
vi.mock('../../server/mcp/workerDeps.js', () => ({
  routeDepsFor: () => ({ home: '/a', exists: () => true, realpath: (p: string) => p, known: async () => [] }),
  openWorkerDepsFor: () => ({
    knownProjects: async () => {
      throw new Error('no worker is opened here');
    },
    home: '/a',
    realpath: async (p: string) => p,
    planWindowPct: () => null,
    now: Date.now,
  }),
  knownRootsOf: async () => [],
  planWindowPct: () => null,
}));
// The server's queue store without SQLite or a socket: reads the queues above, records each write.
vi.mock('../../server/mcp/queueWiring.js', () => ({
  serverQueueStore: () => ({
    read: (sessionId: string) => (live.queues.get(sessionId) as object | undefined) ?? { items: [], automation: null },
    write: (sessionId: string, items: unknown[], automation: unknown, origin: string) => {
      live.queues.set(sessionId, { items, automation });
      live.queueWrites.push({ sessionId, automation, origin });
    },
  }),
}));
vi.mock('../../server/promptWiring.js', () => ({
  createServerPromptSubmitter: () => ({
    hasRoom: () => true,
    submit: async () => ({ outcome: 'submitted', typed: true }),
    interrupt: async (target: { sessionId: string; terminalId: string }) => {
      live.interrupts.push(target);
      return true;
    },
  }),
}));

import { emitTerminalHook, _resetHookSignalsForTests } from '../../server/hookSignals.js';
import { CLEANUP_EVERY_MS } from '../../server/mcp/cleanup.js';
import { createServerDeliver } from '../../server/mcp/deliverWiring.js';
import { centralEscBook } from '../../server/mcp/escHold.js';
import { AGENT_GONE_MS, STOP_SETTLE_MS, TICK_MS } from '../../server/mcp/ledger.js';
import { workers } from '../../server/mcp/workers.js';
import * as presence from '../../server/presenceManager.js';
import { globalInput } from './centralFixtures.js';

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  live.sessions.clear();
  live.aliases.clear();
  live.exitListeners.clear();
  live.opsTerminals.clear();
  live.interrupts.length = 0;
  live.away.clear();
  live.queues.clear();
  live.queueWrites.length = 0;
  live.db = new DatabaseSync(':memory:');
  _resetHookSignalsForTests();
  presence._resetForTests(() => Date.now());
});
afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const worker = makeSession('w1', { terminalId: 'term-w1', status: 'waiting' });
  live.sessions.set('w1', worker);
  live.sessions.set('card-1', makeSession('card-1', { central: { centralId: central.centralId, kind: 'global', scopeRef: null } }));
  const api = fakeClient({
    'POST /sessions/w1/prompt': ok({ success: true, data: { accepted: true } }, 202),
    'POST /sessions/w2/prompt': ok({ success: true, data: { accepted: true } }, 202),
  });
  const clientFor = vi.fn(() => api);
  const deliver = createServerDeliver(registry, clientFor);
  return { registry, central, worker, api, clientFor, deliver };
}

const hook = (event: string, s: Partial<Session> & { sessionId: string }): void => {
  const current = { ...(live.sessions.get(s.sessionId) as Session), ...s };
  live.sessions.set(s.sessionId, current);
  emitTerminalHook(event, current);
};

/** The worker takes the task's own prompt: its UserPromptSubmit, with the envelope AASC typed on the card. */
const takePrompt = (api: ReturnType<typeof setup>['api'], status: Session['status'] = 'prompting'): void => {
  const typed = api.calls.filter((c) => c.method === 'POST').at(-1)?.body as { text: string };
  hook('UserPromptSubmit', { sessionId: 'w1', status, currentPrompt: typed.text });
};

describe('the server’s P2 runtime', () => {
  it('sends a task’s prompt through the central’s own /api client', async () => {
    const { central, worker, api, clientFor, deliver } = setup();

    const task = deliver.ledger.create({ central, session: worker, task: 'fix it' });
    await flush();

    expect(clientFor).toHaveBeenCalledWith(expect.objectContaining({ centralId: central.centralId, token: '' }));
    expect(api.calls).toEqual([
      { method: 'POST', path: '/sessions/w1/prompt', body: { text: expect.stringContaining('fix it'), key: task.promptKey, mode: 'now' } },
    ]);
    expect(deliver.ledger.get(task.taskId)?.state).toBe('sent');
  });

  it('hears the worker’s hooks and its terminal’s exit', async () => {
    const { central, worker, api, deliver } = setup();
    const task = deliver.ledger.create({ central, session: worker, task: 'fix it' });
    await flush();

    // A prompt that is not the task's own starts nothing.
    hook('UserPromptSubmit', { sessionId: 'w1', status: 'prompting', currentPrompt: 'a person’s prompt' });
    expect(deliver.ledger.get(task.taskId)?.state).toBe('sent');
    takePrompt(api);
    expect(deliver.ledger.get(task.taskId)?.state).toBe('running');

    for (const listener of [...live.exitListeners]) listener('term-w1');
    expect(deliver.ledger.get(task.taskId)?.state).toBe('failed');
  });

  it('cancels with the prompt route’s own Esc, noted in the book of central Escs first', async () => {
    const { central, worker, api, deliver } = setup();
    const task = deliver.ledger.create({ central, session: worker, task: 'fix it' });
    await flush();
    takePrompt(api, 'working');
    vi.setSystemTime(Date.now() + 1_000);
    const at = Date.now();

    const outcome = await deliver.ledger.cancel(task.taskId, central.centralId, { mayPress: true });

    expect(outcome.how).toBe('pressed');
    expect(live.interrupts).toEqual([{ sessionId: 'w1', terminalId: 'term-w1' }]);
    expect(centralEscBook.at('w1', 'term-w1')).toBe(at);
  });

  it('counts task ids on from the highest one the activity log holds (a restart keeps the database)', async () => {
    const first = setup();
    expect(first.deliver.ledger.create({ central: first.central, session: first.worker, task: 'one' }).taskId).toBe('T1');
    await flush();
    first.deliver.close();

    const again = createServerDeliver(first.registry, first.clientFor);
    const next = again.ledger.create({ central: first.central, session: makeSession('w2', { terminalId: 'term-w2', status: 'waiting' }), task: 'two' });

    expect(next.taskId).toBe('T2');
    expect(again.ledger.isFromBeforeRestart('T1')).toBe(true);
    again.close();
  });

  it('fails a task once its terminal has not shown the agent for 10 s', async () => {
    const { central, worker, api, deliver } = setup();
    const task = deliver.ledger.create({ central, session: worker, task: 'fix it' });
    await flush();
    takePrompt(api, 'working');

    live.away.add('term-w1');
    await vi.advanceTimersByTimeAsync(TICK_MS + AGENT_GONE_MS);

    expect(deliver.ledger.get(task.taskId)).toMatchObject({ state: 'failed', error: expect.stringMatching(/agent left its terminal/) });
  });

  it('continues a stalled task on the session queue’s own resume prompt', async () => {
    const { central, worker, api, deliver } = setup();
    live.queues.set('w1', { automation: { resumePrompt: 'Pick up where the API error stopped you.' } });
    const task = deliver.ledger.create({ central, session: worker, task: 'fix it' });
    await flush();
    takePrompt(api, 'working');
    hook('Stop', { sessionId: 'w1', status: 'waiting', interruption: { kind: 'rate_limit', line: 'API Error: 529', detectedAt: Date.now() } });
    await vi.advanceTimersByTimeAsync(STOP_SETTLE_MS + 10);
    expect(deliver.ledger.get(task.taskId)?.state).toBe('stalled');

    hook('UserPromptSubmit', { sessionId: 'w1', status: 'prompting', interruption: null, currentPrompt: 'Pick up where the API error stopped you.' });

    expect(deliver.ledger.get(task.taskId)?.state).toBe('running');
  });

  it('writes the activity log into the server’s database, with the central’s card', async () => {
    const { central, worker, deliver } = setup();

    deliver.ledger.create({ central, session: worker, task: 'fix it' });
    await flush();

    const rows = (live.db as DatabaseSync).prepare('SELECT outcome, central_session_id FROM mcp_activity ORDER BY id').all();
    expect(rows.map((r) => ({ ...(r as object) }))).toEqual([
      { outcome: 'queued', central_session_id: 'card-1' },
      { outcome: 'sent', central_session_id: 'card-1' },
    ]);
    deliver.close();
  });

  it('asks presence who drove a session last, the store for aliases, the terminals for ops shells', () => {
    const { deliver } = setup();
    presence.noteControlActivity('w1', 'desktop-1');
    live.aliases.set('term-old', 'w1');
    live.opsTerminals.add('term-ops');

    expect(deliver.controller('w1')).toMatchObject({ clientId: 'desktop-1' });
    expect(deliver.controller('w2')).toBeNull();
    expect(deliver.resolveSessionId('term-old')).toBe('w1');
    expect(deliver.resolveSessionId('nobody')).toBeNull();
    expect(deliver.isOpsTerminal('term-ops')).toBe(true);
    expect(deliver.isOpsTerminal('term-w1')).toBe(false);
  });

  it('releases a central’s own worker when its terminal exits, and the rest when the central is revoked (P4-3)', () => {
    const { registry, central } = setup();
    const opened = { centralId: central.centralId, openedAt: 1, folder: '/a/proj', cli: 'claude' as const };
    workers.add({ ...opened, terminalId: 'term-w1' });
    workers.add({ ...opened, terminalId: 'term-w2' });
    try {
      for (const listener of [...live.exitListeners]) listener('term-w1');
      expect(workers.of(central.centralId).map((w) => w.terminalId)).toEqual(['term-w2']);

      registry.revoke(central.centralId);
      expect(workers.of(central.centralId)).toEqual([]);
    } finally {
      workers.releaseCentral(central.centralId);
    }
  });
});

describe('the server’s P4 jobs (P4)', () => {
  const MIN = 60_000;

  it('pauses the queue a revoked central left running in its worker, and close() stops the wiring (P4-25, P4-28)', async () => {
    const { registry, central, deliver } = setup();
    const running = { items: [{ id: 1, text: 'run the tests' }], automation: { paused: false, autoSend: true, autoResume: true } };
    live.queues.set('w1', running);
    const opened = { centralId: central.centralId, openedAt: 1, folder: '/a/proj', cli: 'claude' as const };
    workers.add({ ...opened, terminalId: 'term-w1' });
    try {
      registry.revoke(central.centralId);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(10);

      expect(live.queueWrites).toEqual([
        { sessionId: 'w1', automation: expect.objectContaining({ paused: true, autoResume: false, autoSend: true }), origin: 'mcp-release' },
      ]);
      const rows = (live.db as DatabaseSync).prepare('SELECT tool, summary, outcome FROM mcp_activity ORDER BY id').all();
      expect(rows.map((r) => ({ ...(r as object) }))).toEqual([
        { tool: 'central_run_stop', summary: 'paused the queue of #w1 (its central was revoked); its prompts are kept', outcome: 'ok' },
      ]);

      // After close(), a revoke and a terminal exit reach nothing of this runtime.
      deliver.close();
      expect(live.exitListeners.size).toBe(0);
      const again = registry.mint(globalInput());
      live.queues.set('w1', running);
      workers.add({ ...opened, centralId: again.centralId, terminalId: 'term-w1' });
      registry.revoke(again.centralId);
      await vi.dynamicImportSettled();
      await vi.advanceTimersByTimeAsync(10);
      expect(live.queueWrites).toHaveLength(1);
      expect(workers.of(again.centralId)).toHaveLength(1);
    } finally {
      workers.releaseCentral(central.centralId);
      workers.release('term-w1', 'closed');
    }
  });

  it('closes a central’s own idle worker as that central, and stops with close() (P4)', async () => {
    const registry = createCentralRegistry();
    const central = registry.mint(globalInput());
    const now = Date.now();
    live.sessions.set('w1', makeSession('w1', { terminalId: 'term-w1', status: 'idle', lastActivityAt: now - 31 * MIN }));
    const api = fakeClient({ 'DELETE /sessions/w1': ok({ ok: true, removed: true }) });
    const clientFor = vi.fn(() => api);
    workers.add({ centralId: central.centralId, terminalId: 'term-w1', openedAt: now - 40 * MIN, folder: '/a/proj', cli: 'claude' });
    try {
      const deliver = createServerDeliver(registry, clientFor);
      await vi.advanceTimersByTimeAsync(CLEANUP_EVERY_MS);

      expect(api.calls).toEqual([{ method: 'DELETE', path: '/sessions/w1' }]);
      expect(clientFor).toHaveBeenCalledWith(expect.objectContaining({ centralId: central.centralId, token: '' }));
      expect(workers.of(central.centralId)).toEqual([]);
      const rows = (live.db as DatabaseSync).prepare('SELECT tool, summary FROM mcp_activity ORDER BY id').all();
      expect(rows.map((r) => ({ ...(r as object) }))).toEqual([{ tool: 'idle_cleanup', summary: 'close #w1 (its own worker, idle 30 min)' }]);

      deliver.close();
      live.sessions.set('w2', makeSession('w2', { terminalId: 'term-w2', status: 'idle', lastActivityAt: now - 31 * MIN }));
      workers.add({ centralId: central.centralId, terminalId: 'term-w2', openedAt: now - 40 * MIN, folder: '/a/proj', cli: 'claude' });
      await vi.advanceTimersByTimeAsync(2 * CLEANUP_EVERY_MS);
      expect(api.calls).toHaveLength(1);
    } finally {
      workers.releaseCentral(central.centralId);
    }
  });

  it('re-routes a task AASC routed itself when its worker’s terminal closes, as its central (P4)', async () => {
    const { central, worker, api, deliver } = setup();
    live.sessions.set('w2', makeSession('w2', { terminalId: 'term-w2', status: 'waiting' }));
    const task = deliver.ledger.create({ central, session: worker, task: 'fix it', route: { by: 'auto', decision: 'reuse', reasons: ['same folder'] } });
    await flush();
    takePrompt(api, 'working');

    for (const listener of [...live.exitListeners]) listener('term-w1');
    await vi.advanceTimersByTimeAsync(10);

    const rows = (live.db as DatabaseSync).prepare("SELECT summary FROM mcp_activity WHERE tool = 'task_delegate'").all();
    expect(rows.map((r) => (r as { summary: string }).summary)).toEqual([expect.stringMatching(/^re-routed T\d+ from #w1: routed to #w2/)]);
    expect(deliver.ledger.get(task.taskId)).toMatchObject({ sessionId: 'w2', retargetedFrom: 'w1' });
    expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/sessions/w1/prompt', '/sessions/w2/prompt']);
    deliver.close();
  });
});
