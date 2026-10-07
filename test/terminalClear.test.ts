// test/terminalClear.test.ts — `terminal_clear`, the toolbar's "Clear output".
//
// The output belongs to the session, not to one device: every subscriber
// paints the same PTY, and every remount replays the same ring. So a clear is
// done by the SERVER — empty the ring, then tell every subscriber to clear —
// which puts the clear at one point of the output stream for the live view,
// the replay and every device. It changes what every device sees, so it takes
// the same gate as typing and resizing: subscribed, and holding the baton.
import { EventEmitter } from 'node:events';
import { describe, it, beforeAll, beforeEach, afterEach, expect, vi } from 'vitest';

vi.mock('../server/db.js', () => ({
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

// No real PTYs: subscribing succeeds for any id, and the clear is observed.
const { ssh } = vi.hoisted(() => ({
  ssh: { clearTerminalOutput: vi.fn((_id: string) => true) },
}));
vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return {
    ...actual,
    setWsClient: vi.fn(() => true),
    getTerminalGeometry: vi.fn(() => null),
    clearTerminalOutput: ssh.clearTerminalOutput,
  };
});

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: Array<Record<string, unknown>> = [];
  send = vi.fn((raw: string) => { this.sent.push(JSON.parse(raw) as Record<string, unknown>); });
  ping = vi.fn();
  terminate = vi.fn();
  close = vi.fn();
  received(type: string): Array<Record<string, unknown>> {
    return this.sent.filter((m) => m.type === type);
  }
  deliver(msg: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
}

let ws: typeof import('../server/wsManager.js');
let store: typeof import('../server/sessionStore.js');
const connected: FakeSocket[] = [];
let nextClient = 0;

function connect(): FakeSocket {
  const socket = new FakeSocket();
  ws.handleConnection(socket as never, { clientId: `clear-device-${nextClient++}`, label: 'test device', address: '127.0.0.1' });
  connected.push(socket);
  return socket;
}

function subscribe(socket: FakeSocket, terminalId: string): void {
  socket.deliver({ type: 'terminal_subscribe', terminalId });
}

/** Drop everything sent so far (snapshot, presence, geometry). */
function settle(): void {
  for (const c of connected) c.sent.length = 0;
}

let n = 0;
async function newTerminal(): Promise<string> {
  const id = `term-clear-${n++}`;
  await store.createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/terminal-clear/${id}`, command: 'claude' });
  return id;
}

beforeAll(async () => {
  ws = await import('../server/wsManager.js');
  store = await import('../server/sessionStore.js');
});

beforeEach(() => {
  ssh.clearTerminalOutput.mockClear();
  ssh.clearTerminalOutput.mockImplementation(() => true);
});

afterEach(() => {
  for (const socket of connected.splice(0)) socket.emit('close');
});

describe('terminal_clear', () => {
  it('empties the replay ring and tells every device showing that terminal', async () => {
    const id = await newTerminal();
    const desk = connect();
    const phone = connect();
    const elsewhere = connect(); // connected, but not looking at this terminal
    subscribe(desk, id);
    subscribe(phone, id);
    settle();

    desk.deliver({ type: 'terminal_clear', terminalId: id });

    expect(ssh.clearTerminalOutput).toHaveBeenCalledWith(id);
    // The clicking device clears on the same message as everyone else, so its
    // screen and the ring are cleared at the same point of the stream.
    expect(desk.received('terminal_cleared')).toEqual([{ type: 'terminal_cleared', terminalId: id }]);
    expect(phone.received('terminal_cleared')).toEqual([{ type: 'terminal_cleared', terminalId: id }]);
    expect(elsewhere.received('terminal_cleared')).toEqual([]);
  });

  it('is refused for a terminal the device is not subscribed to', async () => {
    const id = await newTerminal();
    const watcher = connect();
    const stranger = connect();
    subscribe(watcher, id);
    settle();

    stranger.deliver({ type: 'terminal_clear', terminalId: id });

    expect(ssh.clearTerminalOutput).not.toHaveBeenCalled();
    expect(watcher.received('terminal_cleared')).toEqual([]);
  });

  it('is refused for a device watching a session another device is driving', async () => {
    const id = await newTerminal();
    const driver = connect();
    const spectator = connect();
    subscribe(driver, id);
    subscribe(spectator, id);
    driver.deliver({ type: 'terminal_input', terminalId: id, data: 'x' }); // takes the baton
    settle();

    spectator.deliver({ type: 'terminal_clear', terminalId: id });

    expect(ssh.clearTerminalOutput).not.toHaveBeenCalled();
    expect(driver.received('terminal_cleared')).toEqual([]);
    expect(spectator.received('terminal_cleared')).toEqual([]);
    // The same explanation a spectator's keystrokes get.
    expect(spectator.received('control_denied')).toHaveLength(1);
  });

  it('announces nothing when the server no longer has the terminal', async () => {
    const id = await newTerminal();
    const desk = connect();
    subscribe(desk, id);
    settle();
    ssh.clearTerminalOutput.mockImplementation(() => false);

    desk.deliver({ type: 'terminal_clear', terminalId: id });

    expect(desk.received('terminal_cleared')).toEqual([]);
  });

  it('ignores a malformed request', async () => {
    const desk = connect();
    settle();
    desk.deliver({ type: 'terminal_clear', terminalId: 42 });
    desk.deliver({ type: 'terminal_clear' });
    expect(ssh.clearTerminalOutput).not.toHaveBeenCalled();
  });
});
