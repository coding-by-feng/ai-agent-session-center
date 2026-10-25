// test/mcp/closedByRoutes.test.ts — the three routes that close a session's terminal on request note a person's close
// (server/mcp/closedBy.ts, Ruling P4-24): POST /sessions/:id/kill, DELETE /sessions/:id, DELETE /terminals/:id. A
// central's call (`mcp:`) and an unstamped one are not noted, so a task their close ends stays re-routable. No process
// is found, terminated or signalled: the process lookup, termination and the PTY close are stand-ins.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));

const mocks = vi.hoisted(() => ({
  findClaudeProcess: vi.fn(() => null),
  terminateProcessTree: vi.fn(async () => true),
  closeTerminal: vi.fn(),
  /** A central's kill closes the card's terminal and waits (Ruling P5-33). */
  closeTerminalAndWait: vi.fn(async () => true),
  /** The cards' terminals, as the fake sshManager runs them (a central's kill needs a live one). */
  live: new Set<string>(),
  broadcast: vi.fn(),
}));

vi.mock('../../server/sessionStore.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/sessionStore.js')>('../../server/sessionStore.js');
  return { ...actual, findClaudeProcess: mocks.findClaudeProcess };
});
vi.mock('../../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/processMonitor.js')>('../../server/processMonitor.js');
  return { ...actual, terminateProcessTree: mocks.terminateProcessTree };
});
vi.mock('../../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/sshManager.js')>('../../server/sshManager.js');
  return {
    ...actual,
    closeTerminal: mocks.closeTerminal,
    closeTerminalAndWait: mocks.closeTerminalAndWait,
    getTerminals: () => [
      ...actual.getTerminals(),
      ...[...mocks.live].map((terminalId) => ({ terminalId }) as ReturnType<typeof actual.getTerminals>[number]),
    ],
  };
});
vi.mock('../../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/wsManager.js')>('../../server/wsManager.js');
  return { ...actual, broadcast: mocks.broadcast };
});

import express from 'express';
import { createServer, type Server } from 'http';
import { _resetClosedByForTests, closedByPerson } from '../../server/mcp/closedBy.js';

let server: Server | null = null;
let baseUrl = '';
let store: typeof import('../../server/sessionStore.js');
let n = 0;
const made: string[] = [];
const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

beforeAll(async () => {
  store = await import('../../server/sessionStore.js');
  const app = express();
  app.use(express.json());
  const { default: apiRouter } = await import('../../server/apiRouter.js');
  app.use('/api', apiRouter);
  server = createServer(app);
  await new Promise<void>((resolveStart) => server!.listen(0, '127.0.0.1', resolveStart));
  const addr = server!.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
  killSpy.mockRestore();
});

beforeEach(() => {
  _resetClosedByForTests();
  mocks.closeTerminal.mockClear();
});
afterEach(() => {
  expect(killSpy).not.toHaveBeenCalled();
  // End the cards: each one's 30 s connecting timer then finds nothing and never broadcasts after the file is done.
  for (const id of made.splice(0)) store.deleteSessionFromMemory(id);
});

async function card(): Promise<string> {
  const id = `term-closed-by-${n++}`;
  await store.createTerminalSession(id, { host: 'localhost', workingDir: '/tmp/closed-by-test', command: 'claude' });
  made.push(id);
  mocks.live.add(id);
  return id;
}

const headers = (clientId: string | null): Record<string, string> => ({
  'Content-Type': 'application/json',
  ...(clientId === null ? {} : { 'x-aasc-client-id': clientId }),
});

const calls = {
  kill: (id: string, clientId: string | null) =>
    fetch(`${baseUrl}/api/sessions/${id}/kill`, { method: 'POST', headers: headers(clientId), body: JSON.stringify({ confirm: true }) }),
  deleteSession: (id: string, clientId: string | null) =>
    fetch(`${baseUrl}/api/sessions/${id}`, { method: 'DELETE', headers: headers(clientId) }),
  deleteTerminal: (id: string, clientId: string | null) =>
    fetch(`${baseUrl}/api/terminals/${id}`, { method: 'DELETE', headers: headers(clientId) }),
};

describe('who closed a terminal (Ruling P4-24)', () => {
  for (const [route, call] of Object.entries(calls)) {
    it(`${route}: a person's close is noted, a central's or an unstamped one is not`, async () => {
      const mine = await card();
      const res = await call(mine, 'desktop-abc');
      expect(res.status).toBe(200);
      expect(mocks.closeTerminal).toHaveBeenCalledWith(mine);
      expect(closedByPerson(mine)).toBe(true);

      const theirs = await card();
      expect((await call(theirs, 'mcp:central-1')).status).toBe(200);
      expect(closedByPerson(theirs)).toBe(false);

      const anon = await card();
      expect((await call(anon, null)).status).toBe(200);
      expect(closedByPerson(anon)).toBe(false);
    });
  }
});
