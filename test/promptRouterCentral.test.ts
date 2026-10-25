// test/promptRouterCentral.test.ts — Ruling 51: a central's prompt (an `mcp:` caller on this Mac) is checked before
// every keystroke, as a remote caller's baton is: it stops once the session goes hands-off, a person drives it, or the
// person stops it with Esc, and the key's outcome says why (`stoppedBy`). The ledger fails the task on that outcome.
// The submitter is a fake that does what the real one does with `mayDrive` (stop at the first false): nothing reaches
// a terminal, and no real session or process is touched.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false }));
vi.mock('../server/logger.js', () => ({ default: log }));

import { forgetTerminalHeard, noteTerminalHeard } from '../server/heardTerminals.js';
import { createCentralEscBook, type CentralEscBook } from '../server/mcp/escHold.js';
import { createLedger, TICK_MS, type LedgerDeps } from '../server/mcp/ledger.js';
import { HUMAN_ACTIVE_MS } from '../server/mcp/policy.js';
import type { CentralRecord } from '../server/mcp/types.js';
import { createPromptRouter, type PromptRouterSession } from '../server/promptRouter.js';
import type { PromptRequest, PromptResult } from '../server/promptSubmit.js';
import type { Session } from '../src/types/session.js';

const NOW = Date.parse('2026-10-24T10:00:00.000Z');
const CENTRAL = 'mcp:c1';

let server: http.Server;
let port: number;
let sessions: Map<string, PromptRouterSession>;
let holder: { clientId: string; lastActivityAt: number } | null;
let book: CentralEscBook;
let sends: Array<{ req: PromptRequest; finish: (r: PromptResult) => void }>;
/** The terminals AASC has heard a hook from (sessionStore `terminalHeard`, Ruling P4-50). */
let heard: Set<string>;

beforeEach(async () => {
  sessions = new Map([['s1', { sessionId: 's1', terminalId: 'term-1', status: 'waiting' }]]);
  heard = new Set(['term-1']);
  holder = null;
  book = createCentralEscBook(() => NOW);
  sends = [];
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createPromptRouter({
      requireVisibleSession: (_req: Request, _res: Response, next: NextFunction) => next(),
      isLocal: () => true,
      remoteAccess: () => () => true,
      clientIdOf: (req) => (typeof req.headers['x-aasc-client-id'] === 'string' ? req.headers['x-aasc-client-id'] : ''),
      getSession: (id) => sessions.get(id) ?? null,
      terminalExists: () => true,
      foregroundProcess: () => 'claude',
      noteControlActivity: () => true,
      canControl: () => true,
      controller: () => (holder === null ? null : { label: 'desktop', online: true, ...holder }),
      resolveImage: () => null,
      submitter: {
        hasRoom: () => true,
        submit: (req) => new Promise<PromptResult>((finish) => sends.push({ req, finish })),
      },
      centralEscAt: (id, terminal) => book.at(id, terminal),
      noteCentralEsc: (id, terminal) => book.note(id, terminal),
      terminalHeard: (terminalId) => heard.has(terminalId),
      now: () => NOW,
    }),
  );
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  vi.useRealTimers();
  await new Promise<void>((r) => server.close(() => r()));
});

async function call(method: string, path: string, body?: unknown, clientId = CENTRAL): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(clientId ? { 'x-aasc-client-id': clientId } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const prompt = (key: string, extra: Record<string, unknown> = {}, clientId = CENTRAL) =>
  call('POST', '/sessions/s1/prompt', { text: 'look at the build', key, ...extra }, clientId);
const outcome = async (key: string) => (await call('GET', `/sessions/s1/prompt/${key}`)).json.data as Record<string, unknown>;
const update = (patch: Partial<PromptRouterSession>): void => {
  const s = sessions.get('s1');
  if (s) sessions.set('s1', { ...s, ...patch });
};

/** What the real submitter does with `mayDrive`: stop at the first false, before the keystroke. */
async function typeOn(send: { req: PromptRequest; finish: (r: PromptResult) => void }): Promise<void> {
  const may = send.req.mayDrive?.('s1') ?? true;
  send.finish(may ? { outcome: 'submitted', typed: true } : { outcome: 'stopped', typed: true });
  await new Promise((r) => setTimeout(r, 20));
}

describe('a central’s prompt, checked before every keystroke', () => {
  it('stops when hands-off turns on mid-send, and says so', async () => {
    expect((await prompt('key-hands-off-1')).status).toBe(202);
    expect(sends[0].req.mayDrive?.('s1')).toBe(true);
    update({ handsOff: true });
    await typeOn(sends[0]);
    expect(await outcome('key-hands-off-1')).toMatchObject({ state: 'stopped', stoppedBy: 'hands-off' });
  });

  it('stops when a person drives the session mid-send (the 60-second rule)', async () => {
    await prompt('key-person-0001');
    holder = { clientId: 'desktop-1', lastActivityAt: NOW - 1_000 };
    await typeOn(sends[0]);
    expect(await outcome('key-person-0001')).toMatchObject({ state: 'stopped', stoppedBy: 'person' });
  });

  it('is not stopped by another central, or by a person who drove it over a minute ago', async () => {
    await prompt('key-other-00001');
    holder = { clientId: 'mcp:c2', lastActivityAt: NOW - 1_000 };
    expect(sends[0].req.mayDrive?.('s1')).toBe(true);
    holder = { clientId: 'desktop-1', lastActivityAt: NOW - HUMAN_ACTIVE_MS };
    await typeOn(sends[0]);
    expect(await outcome('key-other-00001')).toEqual({ key: 'key-other-00001', state: 'submitted' });
  });

  it('stops when the person presses Esc mid-send', async () => {
    await prompt('key-esc-0000001');
    update({ userCancelledAt: NOW + 100 });
    await typeOn(sends[0]);
    expect(await outcome('key-esc-0000001')).toMatchObject({ state: 'stopped', stoppedBy: 'person' });
  });

  it('an interrupt prompt is not stopped by the cancel stamp its own Esc causes', async () => {
    await prompt('key-interrupt-1', { mode: 'interrupt' });
    expect(book.at('s1', 'term-1')).toBe(NOW);
    update({ userCancelledAt: NOW + 600 });
    await typeOn(sends[0]);
    expect((await outcome('key-interrupt-1')).state).toBe('submitted');
  });

  it('adds nothing for the desktop’s own prompt (a local caller that is not a central)', async () => {
    await prompt('key-desktop-001', {}, 'desktop-1');
    expect(sends[0].req.mayDrive).toBeUndefined();
  });
});

describe('the ledger on a send the route stopped', () => {
  it('the submitter stops when hands-off turns on mid-send (mcp: caller) and the task fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const worker = { sessionId: 's1', terminalId: 'term-1', status: 'waiting' } as Session;
    const deps: LedgerDeps = {
      submit: async (sessionId, text, key) => {
        const r = await call('POST', `/sessions/${sessionId}/prompt`, { text, key, mode: 'now' });
        return { accepted: r.status === 202, error: null };
      },
      promptOutcome: async (sessionId, key) => {
        const r = await call('GET', `/sessions/${sessionId}/prompt/${key}`);
        return r.status === 200 ? (r.json.data as { state: 'stopped'; stoppedBy?: 'hands-off' }) : null;
      },
      onTerminalHook: () => () => undefined,
      onTerminalExit: () => () => undefined,
      getSession: () => ({ ...worker }),
      readChat: async () => [],
      interrupt: async () => false,
      now: () => NOW,
    };
    const ledger = createLedger(deps);
    const central = { centralId: 'c1', kind: 'global', scopeRef: null, toolsets: [], token: '', terminalId: null } as unknown as CentralRecord;
    // The ledger reads the server's heard set (Ruling P4-58): its CLI has spoken, so the task is sent at once.
    noteTerminalHeard('term-1');
    const t = ledger.create({ central, session: worker, task: 'look at the build' });
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(ledger.get(t.taskId)?.state).toBe('sent'));
    update({ handsOff: true });
    await typeOn(sends[0]);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.waitFor(() => expect(ledger.get(t.taskId)?.state).toBe('failed'));
    expect(ledger.get(t.taskId)?.error).toBe('Hands-off turned on before AASC finished typing the prompt.');
    expect(ledger.get(t.taskId)?.history.at(-1)?.note).toBe('hands-off turned on');
    ledger.close();
    forgetTerminalHeard('term-1');
  });
});

// Rulings P4-35, P4-41: a card the connecting timeout turned idle with no hook from its terminal (`startHeard: false`)
// may be showing its CLI's folder-trust prompt, where typed text would answer it. A central never types into it.
describe('a card that went idle by the connecting timeout (startHeard: false)', () => {
  const notStarted = (): void => {
    heard.delete('term-1');
    update({ status: 'idle', startHeard: false });
  };

  it('a central’s prompt to a card that went idle by the connecting timeout is refused', async () => {
    notStarted();
    for (const [key, mode] of [['key-not-started-1', 'now'], ['key-not-started-2', 'interrupt']] as const) {
      const r = await prompt(key, { mode });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ success: false, code: 'not_started' });
      expect(String(r.json.error)).toMatch(/has not reported that it started/);
      expect(String(r.json.error)).toMatch(/the person answers it in AASC/);
    }
    expect(sends).toEqual([]);
    // Its interrupt pressed no Esc either.
    expect(book.at('s1', 'term-1')).toBeNull();
  });

  it('after its first hook it is allowed', async () => {
    notStarted();
    expect((await prompt('key-heard-00001')).status).toBe(409);
    // The first hook from the card's terminal hears it and clears the marker (sessionStore handleEvent).
    heard.add('term-1');
    update({ startHeard: undefined });
    expect((await prompt('key-heard-00002')).status).toBe(202);
    expect(sends).toHaveLength(1);
  });

  it('a person’s own prompt to it is unchanged', async () => {
    notStarted();
    expect((await prompt('key-person-own1', {}, 'desktop-1')).status).toBe(202);
    expect((await prompt('key-person-own2', {}, '')).status).toBe(202);
  });
});

describe('the first hook clears the marker before the ledger hears it', () => {
  type Listener = (signal: { event: string; sessionId: string; terminalId: string; status: string }) => void;
  /** A ledger wired to this route, its worker's card read from the route's own sessions, its hooks fired by hand. */
  function wiredLedger(): { ledger: ReturnType<typeof createLedger>; hook: (event: string) => void } {
    const listeners: Listener[] = [];
    const deps: LedgerDeps = {
      submit: async (sessionId, text, key) => {
        const r = await call('POST', `/sessions/${sessionId}/prompt`, { text, key, mode: 'now' });
        return { accepted: r.status === 202, error: r.status === 202 ? null : String(r.json.error) };
      },
      promptOutcome: async () => null,
      onTerminalHook: (_terminalId, listener) => {
        listeners.push(listener);
        return () => undefined;
      },
      onTerminalExit: () => () => undefined,
      getSession: (id) => (sessions.get(id) as Session | undefined) ?? null,
      readChat: async () => [],
      interrupt: async () => false,
      now: () => NOW,
    };
    const hook = (event: string): void => {
      for (const l of [...listeners]) l({ event, sessionId: 's1', terminalId: 'term-1', status: 'idle' });
    };
    return { ledger: createLedger(deps), hook };
  }
  const central = { centralId: 'c1', kind: 'global', scopeRef: null, toolsets: [], token: '', terminalId: null } as unknown as CentralRecord;

  it('a task for such a card waits, and is sent (not refused) when the first hook comes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    // The route reads `heard`, the ledger the server's heard set (Ruling P4-58): both start unheard.
    heard.delete('term-1');
    forgetTerminalHeard('term-1');
    update({ status: 'idle', startHeard: false });
    const { ledger, hook } = wiredLedger();
    const t = ledger.create({ central, session: sessions.get('s1') as Session, task: 'look at the build' });
    await vi.advanceTimersByTimeAsync(10_000);
    // Real time for a send to the route (an HTTP round trip) to land, were one made.
    await new Promise((r) => setTimeout(r, 100));
    expect(sends).toEqual([]);
    expect(ledger.get(t.taskId)?.state).toBe('queued');

    // The hook pipeline's order: the store hears the terminal and clears the marker in handleEvent, then the hook's
    // listeners hear it.
    heard.add('term-1');
    noteTerminalHeard('term-1');
    update({ startHeard: undefined });
    hook('SessionStart');
    await vi.waitFor(() => expect(sends).toHaveLength(1));
    await vi.waitFor(() => expect(ledger.get(t.taskId)?.state).toBe('sent'));
    await typeOn(sends[0]);
    ledger.close();
    forgetTerminalHeard('term-1');
  });
});

// Ruling P4-50: the check is positive. A central types only into a terminal AASC has heard a hook from, whatever the
// card's command: a plain shell card, or a CLI launched behind a wrapper (`env X=1 claude`, `npx …`), is idle at 3 s
// with no marker, and the person may have started a CLI in it that now shows its folder-trust prompt.
describe('a card whose terminal never hooked (Ruling P4-50)', () => {
  it('a central’s prompt to a plain shell card that never hooked is refused', async () => {
    heard.clear();
    update({ status: 'idle' });
    for (const [key, mode] of [['key-shell-00001', 'now'], ['key-shell-00002', 'interrupt']] as const) {
      const r = await prompt(key, { mode });
      expect(r.status).toBe(409);
      expect(r.json).toMatchObject({ code: 'not_started' });
    }
    expect(sends).toEqual([]);
    expect(book.at('s1', 'term-1')).toBeNull();
  });

  it('a central’s prompt to a card launched as env X=1 claude that never hooked is refused', async () => {
    // The 3 s branch flipped it idle and set no marker; the agent is in front, at its trust prompt.
    heard.clear();
    update({ status: 'idle', startHeard: undefined });
    expect((await prompt('key-env-claude1')).status).toBe(409);
    expect(sends).toEqual([]);
    // A person's own prompt is unchanged.
    expect((await prompt('key-env-claude2', {}, 'desktop-1')).status).toBe(202);
  });
});
