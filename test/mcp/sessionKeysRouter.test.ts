// test/mcp/sessionKeysRouter.test.ts — the keys route and the clear route (server/sessionKeysRouter.ts, Task 13):
// POST /api/sessions/:id/keys presses one key of `KEY_BYTES` in an agent's terminal, refused in a fixed order
// (remote, unknown, bad key, not started, no agent in front, mid turn, a dialog open, no menu known open, a second
// esc on an idle card); POST /api/terminals/:id/clear empties a terminal's replay and tells its viewers once.
// The menu marks are server/mcp/menuMark.ts's, set here as command_run sets them; the route's clock is the rig's.
//
// The router is mounted on a real Express app on an ephemeral loopback port, with fake deps: no store, no PTY, no
// socket. A request is "remote" when it carries the test's own header, which the fake `isLocal` reads.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMenuMarks, markMenuOpen, MENU_MARK_GRACE_MS, MENU_MARK_MS, menuMarked } from '../../server/mcp/menuMark.js';
import {
  createSessionKeysRouter,
  KEY_BYTES,
  KEY_NAMES,
  type SessionKeysDeps,
  type SessionKeysSession,
} from '../../server/sessionKeysRouter.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const REMOTE = 'x-test-remote';

interface Rig {
  port: number;
  writes: Array<[string, string]>;
  cleared: string[];
  broadcasts: string[];
}

let server: Server | undefined;

/** Closes the rig's server, so a test can build another. */
async function closeServer(): Promise<void> {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
}

afterEach(closeServer);
afterEach(clearMenuMarks);

/** The rig's clock: the time the route reads, which a test moves on. */
const T0 = 1_700_000_000_000;
let clock = T0;
afterEach(() => {
  clock = T0;
});

const card = (over: Partial<SessionKeysSession> = {}): SessionKeysSession => ({
  sessionId: 's1',
  terminalId: 'term-s1',
  status: 'waiting',
  pendingRequest: null,
  lastActivityAt: T0 - 10_000,
  ...over,
});

async function rig(opts: { session?: SessionKeysSession | null; heard?: boolean; agent?: boolean; terminals?: string[] } = {}): Promise<Rig> {
  const writes: Rig['writes'] = [];
  const cleared: string[] = [];
  const broadcasts: string[] = [];
  const session = opts.session === undefined ? card() : opts.session;
  const terminals = new Set(opts.terminals ?? ['term-s1']);
  const deps: SessionKeysDeps = {
    isLocal: (req) => req.headers[REMOTE] === undefined,
    getSession: (id) => (session !== null && id === session.sessionId ? { ...session } : null),
    writeToTerminal: (terminalId, bytes) => {
      writes.push([terminalId, bytes]);
    },
    clearTerminalOutput: (terminalId) => {
      if (!terminals.has(terminalId)) return false;
      cleared.push(terminalId);
      return true;
    },
    broadcastTerminalCleared: (terminalId) => {
      broadcasts.push(terminalId);
    },
    foregroundIsAgent: () => opts.agent ?? true,
    terminalHeard: () => opts.heard ?? true,
    now: () => clock,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createSessionKeysRouter(deps));
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, writes, cleared, broadcasts };
}

interface Answer {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? null : JSON.parse(text) }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const press = (r: Rig, key: unknown, headers: Record<string, string> = {}, id = 's1') =>
  post(r.port, `/api/sessions/${id}/keys`, { key }, headers);

describe('POST /api/sessions/:id/keys', () => {
  it('the bytes written are exactly KEY_BYTES[key]', async () => {
    const r = await rig();

    for (const key of KEY_NAMES) {
      markMenuOpen('term-s1', T0);
      const answer = await press(r, key);
      expect(answer.status, key).toBe(200);
      expect(answer.body).toEqual({ ok: true });
    }

    expect(r.writes).toEqual(KEY_NAMES.map((key) => ['term-s1', KEY_BYTES[key]]));
    expect(KEY_BYTES).toEqual({
      esc: '\x1b', enter: '\r', tab: '\t', up: '\x1b[A', down: '\x1b[B',
      1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
    });
  });

  it('ctrl-c is not a key (the route)', async () => {
    const r = await rig();

    for (const key of ['ctrl-c', 'ctrl+c', '\x03', 'c', '0', '10', 'ESC', 'constructor', '__proto__', 'toString', '', 3, null]) {
      const answer = await press(r, key);
      expect(answer.status, String(key)).toBe(400);
      expect(answer.body.error).toBe('bad-key');
    }
    expect((await post(r.port, '/api/sessions/s1/keys', {})).status).toBe(400);
    expect((await post(r.port, '/api/sessions/s1/keys', ['esc'])).status).toBe(400);
    expect(Object.keys(KEY_BYTES)).not.toContain('ctrl-c');
    expect(Object.values(KEY_BYTES)).not.toContain('\x03');
    expect(r.writes).toEqual([]);
  });

  it('a remote caller is 403', async () => {
    const r = await rig();

    const keys = await press(r, 'enter', { [REMOTE]: '1' });
    const clear = await post(r.port, '/api/terminals/term-s1/clear', undefined, { [REMOTE]: '1' });

    expect(keys.status).toBe(403);
    expect(clear.status).toBe(403);
    expect(r.writes).toEqual([]);
    expect(r.cleared).toEqual([]);
  });

  it('is 404 for a card it does not have, or one with no terminal', async () => {
    const none = await rig({ session: null });
    expect((await press(none, 'enter')).status).toBe(404);
    await closeServer();
    const noTerminal = await rig({ session: card({ terminalId: null }) });
    expect((await press(noTerminal, 'enter')).status).toBe(404);
    expect(noTerminal.writes).toEqual([]);
  });

  it('keys to a never-started card are refused', async () => {
    const unheard = await rig({ heard: false });
    const answer = await press(unheard, 'enter');
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe('not_started');
    expect(unheard.writes).toEqual([]);
  });

  it('refuses a card the connecting timeout marked never-started, though its terminal was heard', async () => {
    const r = await rig({ session: card({ startHeard: false }) });
    const answer = await press(r, 'down');
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe('not_started');
  });

  it('a shell in front is agent_not_running', async () => {
    const shell = await rig({ agent: false });
    const answer = await press(shell, 'enter');
    expect(answer.status).toBe(409);
    expect(answer.body.error).toBe('agent_not_running');
    expect(shell.writes).toEqual([]);
  });

  it('esc is refused while working', async () => {
    for (const status of ['working', 'prompting', 'approval', 'input']) {
      const r = await rig({ session: card({ status }) });
      const answer = await press(r, 'esc');
      expect(answer.status, status).toBe(409);
      expect(answer.body.error, status).toBe('mid_turn');
      expect(r.writes, status).toEqual([]);
      await closeServer();
    }
    const idle = await rig({ session: card({ status: 'idle' }) });
    expect((await press(idle, 'esc')).status).toBe(200);
    expect(idle.writes).toEqual([['term-s1', '\x1b']]);
  });

  it('digits, enter and tab are refused while a dialog is open', async () => {
    const dialogs: SessionKeysSession[] = [
      card({ pendingRequest: { requestId: 'r1' } }),
      card({ status: 'approval' }),
      card({ status: 'input' }),
    ];
    for (const session of dialogs) {
      const r = await rig({ session });
      for (const key of ['1', '2', '9', 'enter', 'tab']) {
        const answer = await press(r, key);
        expect(answer.status, key).toBe(409);
        expect(answer.body.error, key).toBe('awaiting_answer');
      }
      expect(r.writes).toEqual([]);
      await closeServer();
    }
  });

  it('up and down pass with a dialog open', async () => {
    const r = await rig({ session: card({ status: 'approval', pendingRequest: { requestId: 'r1' } }) });

    expect((await press(r, 'up')).status).toBe(200);
    expect((await press(r, 'down')).status).toBe(200);

    expect(r.writes).toEqual([['term-s1', '\x1b[A'], ['term-s1', '\x1b[B']]);
  });

  it('up then enter on an idle card is refused: no menu is known open', async () => {
    for (const status of ['idle', 'waiting']) {
      const r = await rig({ session: card({ status }) });
      for (const key of ['up', 'enter', 'down', 'tab', '1']) {
        const answer = await press(r, key);
        expect(answer.status, `${status} ${key}`).toBe(409);
        expect(answer.body.error, `${status} ${key}`).toBe('no_menu');
      }
      expect(r.writes, status).toEqual([]);
      await closeServer();
    }
  });

  it('after command_run marks a menu open, down and enter pass', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });
    markMenuOpen('term-s1', T0);
    clock = T0 + 5_000;

    expect((await press(r, 'down')).status).toBe(200);
    expect((await press(r, 'enter')).status).toBe(200);

    expect(r.writes).toEqual([['term-s1', '\x1b[B'], ['term-s1', '\r']]);
  });

  it('a mark opens no key while the card is mid-turn (ruling P3-40)', async () => {
    for (const status of ['working', 'prompting']) {
      const r = await rig({ session: card({ status }) });
      markMenuOpen('term-s1', T0);
      for (const key of ['up', 'enter', 'down']) {
        const answer = await press(r, key);
        expect(answer.status, `${status} ${key}`).toBe(409);
        expect(answer.body.error, `${status} ${key}`).toBe('no_menu');
      }
      expect(r.writes, status).toEqual([]);
      await closeServer();
    }
  });

  it('a mark is the terminal’s own: another terminal’s does not open this one', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });
    markMenuOpen('term-other', T0);

    expect((await press(r, 'down')).body.error).toBe('no_menu');
  });

  it('the mark expires after 60 s', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });
    markMenuOpen('term-s1', T0);

    clock = T0 + MENU_MARK_MS - 1;
    expect((await press(r, 'down')).status).toBe(200);
    clock = T0 + MENU_MARK_MS;
    expect((await press(r, 'down')).body.error).toBe('no_menu');
    clock = T0 + 1_000;
    expect((await press(r, 'down')).body.error, 'an expired mark is gone').toBe('no_menu');
  });

  it('the mark ends once the card has had a hook later than its grace window', async () => {
    const r = await rig({ session: card({ status: 'idle', lastActivityAt: T0 + 6_000 }) });
    markMenuOpen('term-s1', T0);
    clock = T0 + 7_000;

    expect((await press(r, 'enter')).body.error).toBe('no_menu');
    expect(r.writes).toEqual([]);
  });

  it('a hook within the grace window (the command’s own prompt hook) keeps the mark', async () => {
    const r = await rig({ session: card({ status: 'idle', lastActivityAt: T0 + 1_000 }) });
    markMenuOpen('term-s1', T0);
    clock = T0 + 7_000;

    expect((await press(r, 'enter')).status).toBe(200);
    expect(MENU_MARK_GRACE_MS).toBe(5_000);
  });

  it('a second esc within 2 s on an idle card is refused (it would open rewind)', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });

    expect((await press(r, 'esc')).status).toBe(200);
    clock = T0 + 1_999;
    const second = await press(r, 'esc');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('double_esc');
    clock = T0 + 4_000;
    expect((await press(r, 'esc')).status, 'two seconds after the last one it passes').toBe(200);

    expect(r.writes).toEqual([['term-s1', '\x1b'], ['term-s1', '\x1b']]);
  });

  it('/review, esc, up, then enter: the esc closed the menu, so enter is refused', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });
    markMenuOpen('term-s1', T0);

    expect((await press(r, 'esc')).status).toBe(200);
    clock = T0 + 3_000;
    expect((await press(r, 'up')).body.error).toBe('no_menu');
    const enter = await press(r, 'enter');
    expect(enter.status).toBe(409);
    expect(enter.body.error).toBe('no_menu');

    expect(r.writes).toEqual([['term-s1', '\x1b']]);
  });

  it('/review, down, enter passes, and a second enter is refused: enter used the mark up', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });
    markMenuOpen('term-s1', T0);

    expect((await press(r, 'down')).status).toBe(200);
    expect((await press(r, 'enter')).status).toBe(200);
    expect((await press(r, 'enter')).body.error).toBe('no_menu');

    expect(r.writes).toEqual([['term-s1', '\x1b[B'], ['term-s1', '\r']]);
  });

  it('up, down and tab keep the mark; a digit ends it', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });
    markMenuOpen('term-s1', T0);

    for (const key of ['up', 'down', 'tab', 'up', '2']) expect((await press(r, key)).status, key).toBe(200);
    expect((await press(r, 'down')).body.error).toBe('no_menu');
  });

  it('a tracked dialog is unchanged: keys there leave a mark alone', async () => {
    const r = await rig({ session: card({ status: 'waiting', pendingRequest: { requestId: 'r1' } }) });
    markMenuOpen('term-s1', T0);

    expect((await press(r, 'esc')).status).toBe(200);
    expect((await press(r, 'down')).status).toBe(200);
    expect(menuMarked('term-s1', 0, T0 + 1)).toBe(true);
  });

  it('a refused esc is not counted as pressed', async () => {
    const r = await rig({ session: card({ status: 'idle' }) });

    expect((await press(r, 'esc')).status).toBe(200);
    clock = T0 + 1_000;
    expect((await press(r, 'esc')).status).toBe(409);
    clock = T0 + 2_500;
    expect((await press(r, 'esc')).status, '2.5 s after the one that was pressed').toBe(200);
  });

  it('refuses in the order the plan gives: unknown before a bad key, a bad key before not started', async () => {
    const none = await rig({ session: null, heard: false, agent: false });
    expect((await press(none, 'ctrl-c')).status).toBe(404);
    await closeServer();
    const both = await rig({ heard: false, agent: false });
    expect((await press(both, 'ctrl-c')).body.error).toBe('bad-key');
    expect((await press(both, 'enter')).body.error).toBe('not_started');
  });
});

describe('POST /api/terminals/:id/clear', () => {
  it('clear clears and broadcasts once', async () => {
    const r = await rig();

    const answer = await post(r.port, '/api/terminals/term-s1/clear', undefined);

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, cleared: true });
    expect(r.cleared).toEqual(['term-s1']);
    expect(r.broadcasts).toEqual(['term-s1']);
  });

  it('is 404 for a terminal it does not have, and tells nobody', async () => {
    const r = await rig();

    const answer = await post(r.port, '/api/terminals/term-gone/clear', undefined);

    expect(answer.status).toBe(404);
    expect(r.broadcasts).toEqual([]);
  });
});
