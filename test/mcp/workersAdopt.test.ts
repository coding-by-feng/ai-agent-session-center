// test/mcp/workersAdopt.test.ts — only a person's input adopts a central's own worker (Ruling P4-23). The desktop
// sends terminal_resize on every attach and fit; that moves presence's baton (arbitration is unchanged) but is not
// input, so the worker stays the central's. Typing into it is input. Runs the real wsManager, presence and worker
// registry over a fake socket; no PTY is opened (sshManager's PTY calls are stand-ins).
import { EventEmitter } from 'node:events';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../../server/sshManager.js')>('../../server/sshManager.js');
  return {
    ...actual,
    setWsClient: vi.fn(() => true),
    getTerminalGeometry: vi.fn(() => null),
    resizeTerminal: vi.fn(() => null),
    writeToTerminal: vi.fn(),
  };
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  send = vi.fn();
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  deliver(msg: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
}

let ws: typeof import('../../server/wsManager.js');
let store: typeof import('../../server/sessionStore.js');
let presence: typeof import('../../server/presenceManager.js');
let workersMod: typeof import('../../server/mcp/workers.js');
const connected: FakeSocket[] = [];
const made: string[] = [];
let n = 0;

beforeAll(async () => {
  ws = await import('../../server/wsManager.js');
  store = await import('../../server/sessionStore.js');
  presence = await import('../../server/presenceManager.js');
  workersMod = await import('../../server/mcp/workers.js');
});

afterEach(() => {
  for (const socket of connected.splice(0)) socket.emit('close');
  // End the cards: each one's 30 s connecting timer then finds nothing and never broadcasts after the file is done.
  for (const id of made.splice(0)) store.deleteSessionFromMemory(id);
});

/** A worker a central opened a moment ago, and the desktop watching its terminal. */
async function ownWorker() {
  const id = `term-adopt-${n++}`;
  await store.createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/workers-adopt/${id}`, command: 'claude' });
  made.push(id);
  const registry = workersMod.createWorkerRegistry();
  registry.add({ centralId: 'c1', terminalId: id, openedAt: Date.now() - 1_000, folder: '/tmp/workers-adopt', cli: 'claude' });
  const desk = new FakeSocket();
  ws.handleConnection(desk as never, { clientId: `desktop-${n}`, label: 'desktop', address: '127.0.0.1' });
  connected.push(desk);
  desk.deliver({ type: 'terminal_subscribe', terminalId: id });
  const card = () => store.getSession(id)!;
  return { id, registry, desk, card };
}

describe('adopting a central’s own worker (Ruling P4-23)', () => {
  it('a desktop resize of an own worker does not adopt it', async () => {
    const { id, registry, desk, card } = await ownWorker();

    desk.deliver({ type: 'terminal_resize', terminalId: id, cols: 120, rows: 40 });
    desk.deliver({ type: 'terminal_clear', terminalId: id });

    // The baton moved to the desktop (arbitration as before), but it gave no input.
    expect(presence.getController(id)?.clientId).toBe(`desktop-${n}`);
    expect(presence.getController(id)?.lastInputAt).toBeUndefined();
    expect(registry.ownerOf(card())).toBe('c1');
  });

  it('typing into it does', async () => {
    const { id, registry, desk, card } = await ownWorker();
    desk.deliver({ type: 'terminal_resize', terminalId: id, cols: 120, rows: 40 });

    desk.deliver({ type: 'terminal_input', terminalId: id, data: 'y' });

    expect(presence.getController(id)?.lastInputAt).toEqual(expect.any(Number));
    expect(registry.ownerOf(card())).toBeNull();
    // For good: a resize afterwards does not make it the central's again.
    desk.deliver({ type: 'terminal_resize', terminalId: id, cols: 100, rows: 40 });
    expect(registry.ownerOf(card())).toBeNull();
  });
});

describe('a terminal’s own replies are not input (Ruling P4-44 F2)', () => {
  it('a focus report into an own worker does not adopt it', async () => {
    const { id, registry, desk, card } = await ownWorker();
    desk.deliver({ type: 'terminal_resize', terminalId: id, cols: 120, rows: 40 });

    // xterm.js reports focus (and answers a Device Attributes query) on its own when the person only clicks the pane.
    desk.deliver({ type: 'terminal_input', terminalId: id, data: '\x1b[I' });
    desk.deliver({ type: 'terminal_input', terminalId: id, data: '\x1b[O\x1b[?62;4c\x1b[>0;276;0c' });

    expect(presence.getController(id)?.lastInputAt).toBeUndefined();
    expect(registry.ownerOf(card())).toBe('c1');

    // A real key after the report still adopts it.
    desk.deliver({ type: 'terminal_input', terminalId: id, data: '\x1b[Iy' });
    expect(presence.getController(id)?.lastInputAt).toEqual(expect.any(Number));
    expect(registry.ownerOf(card())).toBeNull();
  });
});

describe('every complete terminal reply is not input (Ruling P4-49 N2)', () => {
  const REPLIES: Array<[string, string]> = [
    ['a cursor position report', '\x1b[24;80R'],
    ['a DECRQM mode report', '\x1b[?2026;2$y'],
    ['a kitty keyboard report', '\x1b[?0u'],
    ['a window size report', '\x1b[8;40;120t'],
    ['an OSC colour report ended by BEL', '\x1b]11;rgb:0000/0000/0000\x07'],
    ['an OSC title report ended by ST', '\x1b]l;claude\x1b\\'],
    ['a DCS XTVERSION reply', '\x1bP>|xterm.js(5.5.0)\x1b\\'],
    ['several replies in one write', '\x1b[?2026;2$y\x1b[?0u\x1b[24;80R\x1b[?62;4c\x1b[I'],
  ];

  it.each(REPLIES)('%s does not adopt an own worker', async (_name, data) => {
    const { id, registry, desk, card } = await ownWorker();
    desk.deliver({ type: 'terminal_resize', terminalId: id, cols: 120, rows: 40 });

    desk.deliver({ type: 'terminal_input', terminalId: id, data });

    expect(presence.getController(id)?.lastInputAt).toBeUndefined();
    expect(registry.ownerOf(card())).toBe('c1');
  });

  it.each([
    ['an arrow key', '\x1b[A'],
    ['a modified arrow', '\x1b[1;5C'],
    ['an SS3 function key', '\x1bOP'],
    ['a reply followed by a key', '\x1b[24;80Ry'],
    ['a lone escape', '\x1b'],
  ])('%s adopts it', async (_name, data) => {
    const { id, registry, desk, card } = await ownWorker();
    desk.deliver({ type: 'terminal_resize', terminalId: id, cols: 120, rows: 40 });

    desk.deliver({ type: 'terminal_input', terminalId: id, data });

    expect(presence.getController(id)?.lastInputAt).toEqual(expect.any(Number));
    expect(registry.ownerOf(card())).toBeNull();
  });
});

describe('presence keeps input apart from other acts (Ruling P4-23)', () => {
  it('stamps lastInputAt only for input, per holder', () => {
    presence._resetForTests(() => 5_000);
    presence.noteControlActivity('s1', 'desk', false);
    expect(presence.getController('s1')).toMatchObject({ clientId: 'desk', lastActivityAt: 5_000 });
    expect(presence.getController('s1')?.lastInputAt).toBeUndefined();

    presence.noteControlActivity('s1', 'desk');
    expect(presence.getController('s1')?.lastInputAt).toBe(5_000);

    // Another holder that only resizes starts with no input of its own.
    presence.noteControlActivity('s1', 'phone', false);
    expect(presence.getController('s1')?.clientId).toBe('phone');
    expect(presence.getController('s1')?.lastInputAt).toBeUndefined();
    // A claim by the same holder keeps its input time.
    presence.noteControlActivity('s1', 'phone');
    presence.claimControl('s1', 'phone');
    expect(presence.getController('s1')?.lastInputAt).toBe(5_000);
  });
});
