// remoteHandlersAccount.test.ts — the IPC of "one account, all devices" (plan 18, stage 2): remote:accountMachines
// and remote:accountConnect, and the machine proof that remote:check / remote:open now ask of a record made through
// the account. Electron is a stand-in; the store is the real one on a scratch folder; the network is the fixture's,
// with a real seal and real proofs. Nothing here reaches a real server, keychain or window.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { IpcMainInvokeEvent } from 'electron';
import type { AccountDirectory, RemoteComputer, RemoteComputerCheck, RemoteResult } from '../src/types/electron.js';
import {
  fakeAccount, fakeNetwork, fakeTarget, localServerBox, machine, relayTo, sharing,
  LOCAL_ORIGIN, MACHINE_ID, THIS_MACHINE_ID,
  type Box, type FakeAccount, type FakeNetwork, type FakeTarget, type LocalServerOptions, type TargetOptions,
} from './remoteAccountFixture.js';

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const host = vi.hoisted(() => ({ dir: '', keychain: true, encryptFails: false }));

vi.mock('electron', () => ({
  app: { getPath: () => host.dir, isPackaged: false, on: vi.fn() },
  dialog: {},
  crashReporter: {},
  ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  // A reversible stand-in for the OS keychain: the bytes are tagged, so a plain token never appears in the file.
  safeStorage: {
    isEncryptionAvailable: () => host.keychain,
    getSelectedStorageBackend: () => 'keychain',
    encryptString: (value: string) => {
      if (host.encryptFails) throw new Error('keychain locked');
      return Buffer.from(`enc:${Buffer.from(value).toString('hex')}`);
    },
    decryptString: (value: Buffer) => Buffer.from(value.toString().slice(4), 'hex').toString(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  shell: {},
}));

const windows = vi.hoisted(() => ({
  focusRemoteWindow: vi.fn(() => false),
  openRemoteWindow: vi.fn(async (_options: { origin: string; token: string }) => undefined),
  forgetRemoteWindow: vi.fn(async () => undefined),
  openRemoteOrigin: vi.fn((): string | null => null),
  remoteSessionToken: vi.fn(async (): Promise<string | null> => null),
  signBackIn: vi.fn(async () => undefined),
  closeRemoteWindows: vi.fn(),
}));
vi.mock('../electron/remote/remoteWindow.js', async (actual) => ({ ...await actual<object>(), ...windows }));

const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../electron/crashLogger.js', () => ({ logMainError: (line: string) => { logged.lines.push(line); } }));

const LAN = 'http://192.168.1.20:3333';
const TS = 'http://100.101.102.103:3333';
/** Where a relay box reaches the machine: an address this computer never dials. */
const HIDDEN = 'http://10.99.99.9:3333';
const IDENTIFY = '/api/mobile/identify';
const SIGN_IN = [IDENTIFY, '/api/mobile/challenge', '/api/mobile/session'];
const WAITING = 'Waiting for Allow on Mac mini. Check the code there is 482913.';
const DASHBOARD = 'http://localhost:3333/';
const DASHBOARD_SESSION = 'f'.repeat(64);
const NOT_THIS_APP = 'Only this app’s own window can manage remote computers.';
const SOMETHING_ELSE = 'Something else answered at Mac mini’s address.';
const LINK_ID = '00000000-0000-4000-8000-00000000000a';
const LINK_DEVICE = { deviceId: '1b4e28ba-2fa1-41d2-883f-0016d3cca427', deviceToken: 'a-token-of-a-computer-paired-by-link-0123', status: 'active' as const, confirmCode: null };

interface World {
  net: FakeNetwork;
  account: FakeAccount;
  lan: FakeTarget;
  tailnet: FakeTarget;
}

let w: World;
let cookieGet: ReturnType<typeof vi.fn>;
let answers: unknown[];

/** The local server, and the Mac mini at its home-network and Tailscale addresses (one machine, two sockets). */
function world(options: { local?: LocalServerOptions; target?: Partial<TargetOptions> } = {}): World {
  const net = fakeNetwork();
  const account = fakeAccount([machine({ deviceId: THIS_MACHINE_ID, name: 'MacBook Pro', current: true, paths: null }), machine()]);
  net.at(LOCAL_ORIGIN, localServerBox(account, options.local));
  const lan = fakeTarget(account, { address: '192.168.1.20:3333', machineId: MACHINE_ID, ...options.target });
  // One machine: both sockets know the same devices.
  const tailnet = fakeTarget(account, { address: '100.101.102.103:3333', machineId: MACHINE_ID, ...options.target, sameMachineAs: lan });
  net.at(LAN, lan.box);
  net.at(TS, tailnet.box);
  vi.stubGlobal('fetch', net.fetch);
  return { net, account, lan, tailnet };
}

function event(url: string | null = DASHBOARD): IpcMainInvokeEvent {
  return { senderFrame: url === null ? null : { url }, sender: { session: { cookies: { get: cookieGet } } } } as unknown as IpcMainInvokeEvent;
}

async function register(options?: Record<string, unknown>): Promise<void> {
  handlers.clear();
  vi.resetModules();
  const { registerRemoteHandlers } = await import('../electron/ipc/remoteHandlers.js');
  registerRemoteHandlers(options);
}

async function invoke<T>(channel: string, args: unknown[] = [], from: IpcMainInvokeEvent = event()): Promise<T> {
  const answer = await handlers.get(channel)!(from, ...args);
  answers.push(answer);
  return answer as T;
}

const machinesOf = () => invoke<RemoteResult<AccountDirectory>>('remote:accountMachines');
/** Connect to the Mac mini; with an argument, send exactly that as the machine id (`undefined` too). */
const connect = (...id: unknown[]) => invoke<RemoteResult<RemoteComputer>>('remote:accountConnect', id.length ? id : [MACHINE_ID]);
const list = () => invoke<RemoteComputer[]>('remote:list');
const calls = (path: string) => w.net.calls.filter((c) => c.path === path);
const file = () => join(host.dir, 'remote-computers.json');

/** Everything a test must never find in an IPC answer, the store's listing, the file or a log line. */
function secrets(): string[] {
  const keys = w.net.calls.filter((c) => c.path.endsWith('/ticket')).map((c) => (c.body as { clientKey: string }).clientKey);
  const nonces = calls('/api/mobile/enroll-computer').map((c) => (c.body as { nonce: string }).nonce);
  return [...w.account.secrets, ...w.lan.tokens, ...keys, ...nonces, DASHBOARD_SESSION];
}

function expectNoSecretIn(text: string): void {
  for (const secret of secrets()) expect(text).not.toContain(secret);
}

/** The paths one address was asked, in order: all a box there saw of this computer. */
const seenAt = (origin: string) => w.net.calls.filter((c) => new URL(c.url).origin === origin).map((c) => c.path);

/** An AASC from before the machine proof: no /identify route. */
const withoutProof = (box: Box): Box => async (req) => (req.path === IDENTIFY ? { status: 404, body: { error: 'Not found' } } : box(req));

/** The machine can only be reached through a box at its home-network address, which passes every request on. */
function behindRelay(): void {
  w.net.at(HIDDEN, w.tailnet.box);
  w.net.at(TS, null);
  w.net.at(LAN, relayTo(w.net, HIDDEN));
}

/** A record paired by link before plan 18, written the way the store wrote it then (no origin). */
function seedLinkRecord(name = 'Old NUC'): void {
  const token = Buffer.from(`enc:${Buffer.from(LINK_DEVICE.deviceToken).toString('hex')}`).toString('base64');
  writeFileSync(file(), JSON.stringify({
    version: 1,
    computers: [{
      id: LINK_ID, name, lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, status: 'active', confirmCode: null,
      addedAt: 1_000, lastSeenAt: null, deviceId: LINK_DEVICE.deviceId, token,
    }],
  }));
  w.lan.devices.push({ ...LINK_DEVICE });
}

/** The machine's owner presses Allow for this computer. */
function allow(): void {
  for (const device of w.lan.devices) device.status = 'active';
}

beforeEach(async () => {
  host.dir = mkdtempSync(join(tmpdir(), 'aasc-remote-account-'));
  host.keychain = true;
  host.encryptFails = false;
  logged.lines.length = 0;
  answers = [];
  vi.clearAllMocks();
  windows.focusRemoteWindow.mockReturnValue(false);
  windows.openRemoteOrigin.mockReturnValue(null);
  windows.remoteSessionToken.mockResolvedValue(null);
  cookieGet = vi.fn(async () => []);
  vi.stubEnv('SERVER_PORT', '3333');
  w = world();
  await register();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(host.dir, { recursive: true, force: true });
});

describe('remote:accountMachines', () => {
  it('lists the account’s computers, none of them connected yet', async () => {
    const out = await machinesOf();
    expect(out).toMatchObject({
      ok: true,
      data: {
        state: 'ok',
        machines: [
          { deviceId: THIS_MACHINE_ID, name: 'MacBook Pro', current: true, addresses: null, record: null },
          { deviceId: MACHINE_ID, name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.11.0', current: false, connectable: true, record: null },
        ],
      },
    });
    expect(w.net.calls.map((c) => c.url)).toEqual([`${LOCAL_ORIGIN}/api/resources/cloud/machines`]);
  });

  it('adds this computer’s record for a machine it connected through the account, and only that one', async () => {
    seedLinkRecord(); // the same machine, paired by link earlier: not the account's record
    await register();
    const before = await machinesOf();
    expect(before.ok && before.data.machines[1].record).toBeNull();
    const connected = await connect();
    const out = await machinesOf();
    expect(out.ok && out.data.machines[1].record).toEqual(connected.ok && connected.data);
    expect(out.ok && out.data.machines[1].record).toMatchObject({ origin: 'account', backendDeviceId: MACHINE_ID, status: 'pending', confirmCode: '482913', lastSeenAt: null });
    expect(out.ok && out.data.machines[0].record).toBeNull();
  });

  it.each<[string, LocalServerOptions['machines'], string]>([
    ['signed out', { status: 409, body: { success: false, error: { code: 'not_connected', message: 'x' } } }, 'signed-out'],
    ['signed in before this release', { status: 403, body: { success: false, error: { code: 'needs_sign_in', message: 'x' } } }, 'needs-sign-in'],
    ['out of reach of AASC Cloud', 'network-error', 'unreachable'],
  ])('answers a state, not an error, when this computer is %s', async (_name, answer, state) => {
    w = world({ local: { machines: answer } });
    expect(await machinesOf()).toEqual({ ok: true, data: { state, machines: [] } });
  });

  it('says unreachable, and asks nothing, while this computer’s server has no port yet', async () => {
    vi.stubEnv('SERVER_PORT', '');
    expect(await machinesOf()).toEqual({ ok: true, data: { state: 'unreachable', machines: [] } });
    expect(w.net.calls).toEqual([]);
  });

  it('asks as the dashboard window that called: its session goes to this computer’s server and nowhere else', async () => {
    w = world({ target: { enroll: 'auto' } });
    cookieGet.mockResolvedValue([{ name: 'auth_token', value: DASHBOARD_SESSION }]);
    await machinesOf();
    const connected = await connect(); // the enroll, then a sign-in at the machine
    const id = connected.ok ? connected.data.id : '';
    await invoke('remote:check', [id]);
    await invoke('remote:open', [id]);
    expect(cookieGet).toHaveBeenCalledWith({ url: DASHBOARD, name: 'auth_token' });
    const toLocal = w.net.calls.filter((c) => new URL(c.url).origin === LOCAL_ORIGIN);
    const toMachine = w.net.calls.filter((c) => new URL(c.url).origin !== LOCAL_ORIGIN);
    expect(toLocal.map((c) => c.headers.Cookie)).toEqual(Array(3).fill(`auth_token=${DASHBOARD_SESSION}`));
    // Every kind of request a machine gets: the enroll, sign-ins, proofs, its address and its shared sessions.
    expect(new Set(toMachine.map((c) => c.path))).toEqual(new Set([
      '/api/auth/status', '/api/mobile/enroll-computer', '/api/mobile/challenge', '/api/mobile/session', '/api/mobile/identify',
      '/api/mobile/paths', '/api/sessions',
    ]));
    for (const call of toMachine) {
      expect(call.headers, call.url).not.toHaveProperty('Cookie');
      expect(JSON.stringify([call.url, call.headers, call.body ?? null]), call.url).not.toContain(DASHBOARD_SESSION);
      // Nothing sets Host, so fetch names the address dialled: what the machine binds its answers to.
      expect(Object.keys(call.headers).map((name) => name.toLowerCase()), call.url).not.toContain('host');
      expect(['192.168.1.20:3333', '100.101.102.103:3333'], call.url).toContain(new URL(call.url).host);
    }
    expect(JSON.stringify(windows.openRemoteWindow.mock.calls)).not.toContain(DASHBOARD_SESSION);
    expectNoSecretIn(JSON.stringify(answers));
  });

  it('still asks when the window’s cookies can’t be read', async () => {
    cookieGet.mockRejectedValue(new Error('session gone'));
    expect(await machinesOf()).toMatchObject({ ok: true, data: { state: 'ok' } });
    expect(w.net.calls[0].headers).not.toHaveProperty('Cookie');
  });
});

describe('remote:accountConnect', () => {
  it('saves a pending record for the machine and answers it without a secret', async () => {
    const out = await connect();
    expect(out).toEqual({
      ok: true,
      data: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: 'Mac mini', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333,
        status: 'pending', confirmCode: '482913', addedAt: expect.any(Number), lastSeenAt: null, origin: 'account', backendDeviceId: MACHINE_ID,
      },
    });
    expect(await list()).toEqual([out.ok && out.data]);
    expect(w.lan.devices).toHaveLength(1);
    // The token is on disk only as the keychain wrote it, and in no answer.
    const stored = readFileSync(file(), 'utf8');
    expect(stored).toContain(Buffer.from(`enc:${Buffer.from(w.lan.tokens[0]).toString('hex')}`).toString('base64'));
    expectNoSecretIn(stored);
    expectNoSecretIn(JSON.stringify(answers));
    expect(JSON.stringify(answers)).not.toContain(w.lan.devices[0].deviceId);
    expect(logged.lines).toEqual([]);
    // Waiting for Allow: no sign-in was spent.
    expect(calls('/api/mobile/challenge')).toEqual([]);
  });

  it('signs in at once when the machine connects without asking, so its record is confirmed there', async () => {
    w = world({ target: { enroll: 'auto' } });
    const out = await connect();
    expect(out).toMatchObject({ ok: true, data: { status: 'active', confirmCode: null, lastSeenAt: expect.any(Number) } });
    expect(w.lan.sessionsMinted).toBe(1);
    // That sign-in asked the machine to prove itself first.
    expect(seenAt(LAN)).toEqual(['/api/auth/status', '/api/mobile/enroll-computer', ...SIGN_IN]);
    expectNoSecretIn(JSON.stringify(answers));
  });

  // Connecting again must not trade a key the machine accepts, or is about to, for a new one that waits for Allow.
  describe('when this computer already has a record for the machine', () => {
    const tickets = () => w.net.calls.filter((c) => c.path.endsWith('/ticket'));

    it('does not enroll again while it waits for Allow: the record it has is checked and answered', async () => {
      const first = await connect();
      w.net.calls.length = 0;
      const second = await connect();
      expect(second).toEqual(first);
      expect(second).toMatchObject({ ok: true, data: { status: 'pending', confirmCode: '482913' } });
      expect(tickets()).toEqual([]);
      expect(calls('/api/mobile/enroll-computer')).toEqual([]);
      expect(w.lan.tokens).toHaveLength(1);
      // The check of a waiting record asks the machine for its proof and nothing more.
      expect([...seenAt(LAN), ...seenAt(TS)]).toEqual([IDENTIFY, IDENTIFY]);
    });

    it('learns it was allowed without enrolling again: a waiting record that now verifies is answered as active', async () => {
      const first = await connect();
      allow();
      w.net.calls.length = 0;
      const second = await connect();
      expect(second).toMatchObject({ ok: true, data: { id: first.ok && first.data.id, status: 'active', confirmCode: null, lastSeenAt: expect.any(Number) } });
      expect(tickets()).toEqual([]);
      expect(w.lan.tokens).toHaveLength(1);
    });

    it('does not swap a working key for a pending one: an allowed record that verifies is answered unchanged, with no ticket', async () => {
      const first = await connect();
      const id = first.ok ? first.data.id : '';
      allow();
      await invoke('remote:check', [id]);
      const stored = readFileSync(file(), 'utf8');
      w.net.calls.length = 0;
      const second = await connect();
      expect(second).toMatchObject({ ok: true, data: { id, status: 'active', confirmCode: null } });
      expect(tickets()).toEqual([]);
      expect(calls('/api/mobile/enroll-computer')).toEqual([]);
      expect(w.lan.tokens).toHaveLength(1);
      expect(w.lan.devices).toHaveLength(1);
      expect(await list()).toHaveLength(1);
      // The same key, as the keychain wrote it the first time.
      const key = Buffer.from(`enc:${Buffer.from(w.lan.tokens[0]).toString('hex')}`).toString('base64');
      expect(stored).toContain(key);
      expect(readFileSync(file(), 'utf8')).toContain(key);
    });

    it('answers the record it has even when AASC Cloud can’t be reached', async () => {
      const first = await connect();
      w.net.at(LOCAL_ORIGIN, null);
      expect(await connect()).toEqual(first);
      expect(w.lan.tokens).toHaveLength(1);
    });

    // Decision, Nov 20: an allowed record whose machine no longer proves itself (the owner removed this computer there,
    // which reads the same as a box in the machine's place) may enroll again. That is safe where a sign-in is not: only
    // the machine can redeem the ticket, and its answer opens only for the address dialled.
    it.each<['ask' | 'auto', string]>([
      ['ask', 'pending'], ['auto', 'active'],
    ])('enrolls again into the same row when an allowed record no longer proves itself (the machine set to %s)', async (enroll, status) => {
      w = world({ target: { enroll } });
      const first = await connect();
      const id = first.ok ? first.data.id : '';
      allow();
      await invoke('remote:check', [id]);
      expect((await list())[0]).toMatchObject({ status: 'active' });
      w.lan.devices.length = 0; // removed in "Phones & computers" on the machine
      w.net.calls.length = 0;
      const second = await connect();
      expect(second).toMatchObject({ ok: true, data: { id, status, origin: 'account', backendDeviceId: MACHINE_ID } });
      expect(tickets()).toHaveLength(1);
      // First the check, which asked for the proof and got none; only then the enroll.
      expect(seenAt(LAN).slice(0, 3)).toEqual([IDENTIFY, '/api/auth/status', '/api/mobile/enroll-computer']);
      expect(await list()).toHaveLength(1);
      expect(w.lan.tokens).toHaveLength(2);
      const stored = readFileSync(file(), 'utf8');
      expect(stored).toContain(Buffer.from(`enc:${Buffer.from(w.lan.tokens[1]).toString('hex')}`).toString('base64'));
      expect(stored).not.toContain(Buffer.from(`enc:${Buffer.from(w.lan.tokens[0]).toString('hex')}`).toString('base64'));
      expectNoSecretIn(JSON.stringify(answers));
    });

    it('asks for no ticket when nothing answers anywhere: the record stays, and the answer says it is offline', async () => {
      const first = await connect();
      const id = first.ok ? first.data.id : '';
      allow();
      await invoke('remote:check', [id]);
      const before = readFileSync(file(), 'utf8');
      w.net.at(LAN, null);
      w.net.at(TS, null);
      w.net.calls.length = 0;
      const out = await connect();
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toMatch(/^No answer from 192\.168\.1\.20 or 100\.101\.102\.103/);
      expect(tickets()).toEqual([]);
      expect(calls('/api/mobile/enroll-computer')).toEqual([]);
      expect(readFileSync(file(), 'utf8')).toBe(before);
      expect((await list())[0]).toMatchObject({ id, status: 'active' });
    });

    it('asks for no ticket when the machine proves itself but refuses the sign-in: the answer is its reason', async () => {
      const first = await connect();
      const id = first.ok ? first.data.id : '';
      allow();
      await invoke('remote:check', [id]);
      w.net.at(LAN, async (req) => (req.path === '/api/mobile/challenge' ? { status: 429, body: { error: 'Too many attempts' } } : w.lan.box(req)));
      w.net.calls.length = 0;
      const out = await connect();
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toMatch(/too many attempts/i);
      expect(tickets()).toEqual([]);
      expect((await list())[0]).toMatchObject({ id, status: 'active' });
    });

    it('gives a box answering at the machine’s address no new key: its sealed answer does not open, and the old record stays', async () => {
      const first = await connect();
      const id = first.ok ? first.data.id : '';
      allow();
      await invoke('remote:check', [id]);
      const before = readFileSync(file(), 'utf8');
      behindRelay();
      const out = await connect();
      expect(out).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
      // The machine did answer the box (a second device exists there), sealed for its own address: unreadable here
      // and to the box. Nothing of it was kept, and the record this computer had is byte for byte what it was.
      expect(w.lan.tokens).toHaveLength(2);
      expect(readFileSync(file(), 'utf8')).toBe(before);
      expect(await list()).toHaveLength(1);
      expect((await list())[0]).toMatchObject({ id, status: 'active' });
      expectNoSecretIn(JSON.stringify(answers));
      expectNoSecretIn(logged.lines.join('\n'));
    });

    it('keeps the record when it no longer proves itself and AASC Cloud can’t give a ticket', async () => {
      const first = await connect();
      const id = first.ok ? first.data.id : '';
      allow();
      await invoke('remote:check', [id]);
      w.lan.devices.length = 0;
      w.net.at(LOCAL_ORIGIN, null);
      expect(await connect()).toEqual({ ok: false, error: 'Can’t reach AASC Cloud. Try again.' });
      expect((await list())[0]).toMatchObject({ id, status: 'active' });
    });

    it('enrolls again when the record was removed: one row, the same id, the new key', async () => {
      const first = await connect();
      // The row reads "removed" (a record from before the proof came first could learn that from the machine).
      const stored = JSON.parse(readFileSync(file(), 'utf8')) as { computers: Array<Record<string, unknown>> };
      stored.computers[0].status = 'revoked';
      stored.computers[0].confirmCode = null;
      writeFileSync(file(), JSON.stringify(stored));
      await register();
      const second = await connect();
      expect(second).toMatchObject({ ok: true, data: { id: first.ok && first.data.id, status: 'pending', confirmCode: '482913' } });
      expect(tickets()).toHaveLength(2);
      expect(await list()).toHaveLength(1);
      expect(w.lan.tokens).toHaveLength(2);
      const after = readFileSync(file(), 'utf8');
      expect(after).toContain(Buffer.from(`enc:${Buffer.from(w.lan.tokens[1]).toString('hex')}`).toString('base64'));
      expect(after).not.toContain(Buffer.from(`enc:${Buffer.from(w.lan.tokens[0]).toString('hex')}`).toString('base64'));
    });
  });

  it('keeps a record paired by link beside it', async () => {
    seedLinkRecord();
    await register();
    await connect();
    expect((await list()).map((r) => [r.name, r.origin])).toEqual([['Old NUC', 'link'], ['Mac mini', 'account']]);
  });

  it('asks for one ticket when two connects for a machine arrive together', async () => {
    const [a, b] = await Promise.all([connect(), connect()]);
    expect(a).toEqual(b);
    expect(w.net.calls.filter((c) => c.path.endsWith('/ticket'))).toHaveLength(1);
    expect(await list()).toHaveLength(1);
  });

  it.each([
    ['nothing', undefined], ['a number', 7], ['an object', { id: MACHINE_ID }], ['a word', 'mac-mini'],
    ['an upper-case id', MACHINE_ID.toUpperCase()], ['an id with a path', `${MACHINE_ID}/../../status`], ['a very long string', 'a'.repeat(5000)],
  ])('refuses %s as a machine id before anything is asked', async (_name, id) => {
    expect(await connect(id)).toEqual({ ok: false, error: 'That computer isn’t on your AASC Cloud account.' });
    expect(w.net.calls).toEqual([]);
  });

  it('asks for no ticket when this computer has no keychain to keep the key in', async () => {
    host.keychain = false;
    await register();
    const out = await connect();
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/can’t store the pairing key safely/);
    expect(w.net.calls).toEqual([]);
  });

  it('takes itself off the machine again when the key can’t be stored after all', async () => {
    w = world({ target: { enroll: 'auto' } });
    host.encryptFails = true;
    const out = await connect();
    expect(out.ok).toBe(false);
    expect(w.lan.devices).toEqual([]);
    expect(await list()).toEqual([]);
    expectNoSecretIn(JSON.stringify(answers));
  });

  it('saves nothing when a box passes the request on to the machine', async () => {
    w.net.at(LAN, relayTo(w.net, TS));
    expect(await connect()).toEqual({ ok: false, error: 'Something else answered at Mac mini’s address. Nothing was saved.' });
    expect(await list()).toEqual([]);
    expectNoSecretIn(JSON.stringify(answers));
    expectNoSecretIn(logged.lines.join('\n'));
  });

  it('logs no secret when saving fails outright', async () => {
    w = world({ target: { enroll: 'auto' } });
    // The data folder goes away between the enroll and the save: the write throws.
    w.net.at(LAN, async (req) => {
      const answer = await w.lan.box(req);
      if (req.path === '/api/mobile/enroll-computer') rmSync(host.dir, { recursive: true, force: true });
      return answer;
    });
    const out = await connect();
    expect(out).toEqual({ ok: false, error: 'Something went wrong talking to that computer. Try again.' });
    expect(logged.lines).toHaveLength(1);
    expect(logged.lines[0]).toMatch(/^remote:accountConnect failed: /);
    expectNoSecretIn(logged.lines.join('\n'));
    // And the machine isn't left holding a device this computer never kept.
    expect(w.lan.devices).toEqual([]);
  });
});

// Plan 18: a record made through the account trusts no address before the machine proves itself there, so it can take
// the machine's addresses from the account's directory whenever that is read. A record paired by link never does.
describe('an account record follows the machine’s addresses in the directory', () => {
  const NEW_LAN = 'http://192.168.1.77:3333';
  const check = (id: string) => invoke<RemoteResult<RemoteComputerCheck>>('remote:check', [id]);

  /** The Mac mini got a new lease at home, and its Tailscale is off. */
  function moveMachine(): void {
    w.account.machines[1] = machine({ paths: { lan: '192.168.1.77', tailnet: null, public: null, port: 3333, updatedAt: 'x' } });
    w.net.at(LAN, null);
    w.net.at(TS, null);
    w.net.at(NEW_LAN, fakeTarget(w.account, { address: '192.168.1.77:3333', machineId: MACHINE_ID, sameMachineAs: w.lan }).box);
  }

  it('reaches a machine whose home-network address changed, after a directory read', async () => {
    const out = await connect();
    const id = out.ok ? out.data.id : '';
    allow();
    moveMachine();
    // Until the directory is read again it still looks where the machine was.
    expect(await check(id)).toMatchObject({ ok: true, data: { state: 'offline' } });
    const read = await machinesOf();
    expect(read.ok && read.data.machines[1].record).toMatchObject({ id, lan: '192.168.1.77', tailnet: null, port: 3333 });
    w.net.calls.length = 0;
    expect(await check(id)).toMatchObject({ ok: true, data: { state: 'online', via: 'lan' } });
    expect(seenAt(NEW_LAN).slice(0, 3)).toEqual(SIGN_IN);
    expect(seenAt(LAN)).toEqual([]);
    // It is on disk: a restart keeps the new address, and the key.
    await register();
    expect((await list())[0]).toMatchObject({ id, lan: '192.168.1.77', tailnet: null, status: 'active' });
    expect(await check(id)).toMatchObject({ ok: true, data: { state: 'online' } });
  });

  it('leaves a record paired by link with the same name untouched', async () => {
    seedLinkRecord('Mac mini');
    await register();
    await connect();
    const before = (await list())[0];
    moveMachine();
    await machinesOf();
    const rows = await list();
    expect(rows.map((r) => [r.name, r.origin, r.lan, r.tailnet])).toEqual([
      ['Mac mini', 'link', '192.168.1.20', '100.101.102.103'], ['Mac mini', 'account', '192.168.1.77', null],
    ]);
    expect(rows[0]).toEqual(before);
  });

  it('changes nothing when the directory lists an address of the wrong kind', async () => {
    await connect();
    w.account.machines[1] = machine({ paths: { lan: '8.8.8.8', tailnet: '100.64.0.9', public: null, port: 3334, updatedAt: 'x' } });
    const before = readFileSync(file(), 'utf8');
    const read = await machinesOf();
    expect(read.ok && read.data.machines[1]).toMatchObject({
      addresses: null, record: { lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333 },
    });
    expect(readFileSync(file(), 'utf8')).toBe(before);
  });

  it('keeps the addresses it has when the machine shows none', async () => {
    await connect();
    w.account.machines[1] = machine({ paths: null });
    await machinesOf();
    expect((await list())[0]).toMatchObject({ lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333 });
  });

  it('takes them on a connect too, before it checks the record it has', async () => {
    await connect();
    allow();
    moveMachine();
    expect(await connect()).toMatchObject({ ok: true, data: { lan: '192.168.1.77', tailnet: null, status: 'active' } });
  });
});

describe('the preload', () => {
  // The channel is a string in two files; a typo there leaves the switcher quietly empty with every test green.
  it('calls the two channels the handlers register, and a Client’s page is given neither', () => {
    const preload = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8');
    for (const [method, call] of [
      ['accountMachines', "ipcRenderer.invoke('remote:accountMachines')"],
      ['accountConnect', "ipcRenderer.invoke('remote:accountConnect', machineId)"],
    ]) {
      expect(preload, method).toContain(call);
      expect(handlers.has(`remote:${method}`), method).toBe(true);
    }
    expect(readFileSync(new URL('../electron/preloadClient.ts', import.meta.url), 'utf8')).not.toContain('remote:account');
  });
});

describe('who may call the account channels', () => {
  it.each([
    ['a remote computer’s page', 'http://192.168.1.20:3333/'],
    ['a web page', 'https://example.com/'],
    ['a Client’s home page', 'aasc-client://home/'],
    ['a frame already gone', null],
  ])('refuses %s, and asks nothing', async (_name, url) => {
    expect(await invoke('remote:accountMachines', [], event(url))).toEqual({ ok: false, error: NOT_THIS_APP });
    expect(await invoke('remote:accountConnect', [MACHINE_ID], event(url))).toEqual({ ok: false, error: NOT_THIS_APP });
    expect(w.net.calls).toEqual([]);
    expect(cookieGet).not.toHaveBeenCalled();
  });

  it('answers "not in this edition" in a Client, which has no server of its own', async () => {
    const { isClientHomeSenderUrl } = await import('../electron/remote/clientUi.js');
    await register({ isAppSender: isClientHomeSenderUrl });
    const home = event('aasc-client://home/');
    const refusal = { ok: false, error: 'Connecting through an AASC Cloud account isn’t available in this edition.' };
    expect(await invoke('remote:accountMachines', [], home)).toEqual(refusal);
    expect(await invoke('remote:accountConnect', [MACHINE_ID], home)).toEqual(refusal);
    // Even with a server on this computer's port: a Client never asks it.
    expect(w.net.calls).toEqual([]);
    expect(await invoke('remote:accountConnect', [MACHINE_ID], event(DASHBOARD))).toEqual({ ok: false, error: NOT_THIS_APP });
  });
});

describe('the machine proves itself before its session is used', () => {
  const open = (id: string) => invoke<RemoteResult<null>>('remote:open', [id]);
  const check = (id: string) => invoke<RemoteResult<RemoteComputerCheck>>('remote:check', [id]);

  /** Connected, allowed by the machine's owner, and seen as such here: the record is active. */
  async function connected(): Promise<string> {
    const out = await connect();
    const id = out.ok ? out.data.id : '';
    allow();
    await check(id);
    w.net.calls.length = 0;
    return id;
  }

  describe('for a record made through the account', () => {
    it('asks the machine to prove itself first, then signs in and opens the window at that address', async () => {
      const id = await connected();
      expect(await open(id)).toEqual({ ok: true, data: null });
      expect(windows.openRemoteWindow).toHaveBeenCalledOnce();
      expect(windows.openRemoteWindow.mock.calls[0][0]).toMatchObject({ id, name: 'Mac mini', origin: LAN });
      expect(w.net.calls.map((c) => c.path)).toEqual(SIGN_IN);
    });

    it('gives a box that passes everything on no challenge and no sign-in proof, and opens no window', async () => {
      const id = await connected();
      const minted = w.lan.sessionsMinted;
      behindRelay();
      expect(await open(id)).toEqual({ ok: false, error: SOMETHING_ELSE });
      expect(windows.openRemoteWindow).not.toHaveBeenCalled();
      // All the box saw, and all it could pass on: one question whose answer is for the machine's own address.
      expect(seenAt(LAN)).toEqual([IDENTIFY]);
      expect(seenAt(HIDDEN)).toEqual([IDENTIFY]);
      // So the machine minted no session for the box to keep.
      expect(w.lan.sessionsMinted).toBe(minted);
      // The record keeps its state: nothing said the machine removed this computer.
      expect((await list())[0]).toMatchObject({ status: 'active' });
      expectNoSecretIn(JSON.stringify(answers));
    });

    it('goes past such a box to an address where the machine does prove itself', async () => {
      const id = await connected();
      w.net.at(LAN, relayTo(w.net, TS));
      w.net.calls.length = 0;
      expect(await open(id)).toEqual({ ok: true, data: null });
      expect(windows.openRemoteWindow.mock.calls[0][0]).toMatchObject({ origin: TS });
      expect(seenAt(LAN)).toEqual([IDENTIFY]);
    });

    it('opens no window at a machine that offers no proof, and sends it no sign-in', async () => {
      const id = await connected();
      w.net.at(LAN, withoutProof(w.lan.box));
      w.net.at(TS, withoutProof(w.tailnet.box));
      expect(await open(id)).toEqual({ ok: false, error: SOMETHING_ELSE });
      expect(windows.openRemoteWindow).not.toHaveBeenCalled();
      expect(w.net.calls.map((c) => c.path)).toEqual([IDENTIFY, IDENTIFY]);
    });

    it('says so on a check, and asks for nothing else', async () => {
      const id = await connected();
      behindRelay();
      expect(await check(id)).toEqual({ ok: true, data: { state: 'offline', via: null, sharedSessions: null, needsYou: null, message: SOMETHING_ELSE, unproved: true } });
      expect(seenAt(LAN)).toEqual([IDENTIFY]);
    });

    it('is offline in the usual words when nothing answers at all', async () => {
      const id = await connected();
      w.net.at(LAN, null);
      w.net.at(TS, null);
      const out = await check(id);
      expect(out).toMatchObject({ ok: true, data: { state: 'offline' } });
      expect(out.ok && out.data.message).toMatch(/^No answer from 192\.168\.1\.20 or 100\.101\.102\.103/);
    });

    it('checks as online once the machine proved itself', async () => {
      const id = await connected();
      expect(await check(id)).toMatchObject({ ok: true, data: { state: 'online', via: 'lan' } });
      expect((await list())[0]).toMatchObject({ status: 'active', confirmCode: null });
      expect(seenAt(LAN).slice(0, 3)).toEqual(SIGN_IN);
    });

    it('keeps reading "Waiting for Allow" until the owner allows it, asking only for the proof; then it is active', async () => {
      const out = await connect();
      const id = out.ok ? out.data.id : '';
      w.net.calls.length = 0;
      expect(await check(id)).toEqual({ ok: true, data: { state: 'pending', via: null, sharedSessions: null, needsYou: null, message: WAITING } });
      expect(await open(id)).toEqual({ ok: false, error: WAITING });
      // Not allowed yet, so not vouched for: no challenge was asked, at either address, by the check or the open.
      expect(w.net.calls.map((c) => c.path)).toEqual([IDENTIFY, IDENTIFY, IDENTIFY, IDENTIFY]);
      expect((await list())[0]).toMatchObject({ status: 'pending', confirmCode: '482913' });
      allow();
      expect(await check(id)).toMatchObject({ ok: true, data: { state: 'online', via: 'lan' } });
      expect((await list())[0]).toMatchObject({ status: 'active', confirmCode: null, lastSeenAt: expect.any(Number) });
    });

    it('after the machine’s owner removes this computer, says something else answered and sends no sign-in to find out', async () => {
      w = world({ target: { enroll: 'auto' } });
      const out = await connect();
      const id = out.ok ? out.data.id : '';
      w.lan.devices.length = 0; // removed in "Phones & computers" there
      w.net.calls.length = 0;
      expect(await check(id)).toEqual({ ok: true, data: { state: 'offline', via: null, sharedSessions: null, needsYou: null, message: SOMETHING_ELSE, unproved: true } });
      expect(await open(id)).toEqual({ ok: false, error: SOMETHING_ELSE });
      expect(w.net.calls.map((c) => c.path)).toEqual([IDENTIFY, IDENTIFY, IDENTIFY, IDENTIFY]);
      expect(windows.openRemoteWindow).not.toHaveBeenCalled();
      // The row is not marked removed: nothing here can tell that from a box in the machine's place.
      expect((await list())[0]).toMatchObject({ status: 'active' });
    });

    it('on Remove, takes itself off the machine only where the machine proves itself', async () => {
      const id = await connected();
      expect(await invoke('remote:remove', [id])).toEqual({ ok: true, data: { unpairedRemotely: true } });
      expect(seenAt(LAN)).toEqual([IDENTIFY, '/api/mobile/challenge', '/api/mobile/unpair']);
      expect(w.lan.devices).toEqual([]);
      expect(await list()).toEqual([]);
    });

    it('on Remove through a box in the machine’s place, forgets the record here and answers no challenge', async () => {
      const id = await connected();
      behindRelay();
      expect(await invoke('remote:remove', [id])).toEqual({ ok: true, data: { unpairedRemotely: false } });
      expect(seenAt(LAN)).toEqual([IDENTIFY]);
      expect(await list()).toEqual([]);
    });
  });

  // `needsYou`: how many of the shared sessions wait on the person (status approval or input), read from the list
  // the check already fetches for `sharedSessions`. No request is added; nothing of a session is kept but the counts.
  describe('the check counts the sessions that need the person', () => {
    const SESSIONS = {
      a: { sessionId: 'a', status: 'approval', title: 'a private title' }, b: { status: 'input' }, c: { status: 'working' },
      d: { status: 'waiting' }, e: { status: 'idle' }, f: {},
    };
    const requests = () => w.net.calls.splice(0).map((c) => `${c.method} ${c.url}`);
    const data = async (id: string) => {
      const out = await check(id);
      return out.ok ? out.data : null;
    };
    /** Both of the machine's sockets share `sessions`. */
    function share(sessions: unknown): void {
      w.net.at(LAN, sharing(w.lan.box, sessions));
      w.net.at(TS, sharing(w.tailnet.box, sessions));
    }

    describe('for a record made through the account', () => {
      it('counts them from the list it already reads, with no request added', async () => {
        const id = await connected();
        share(SESSIONS);
        expect(await data(id)).toEqual({ state: 'online', via: 'lan', sharedSessions: 6, needsYou: 2, message: null });
        expect(requests()).toEqual([
          `POST ${LAN}${IDENTIFY}`, `POST ${LAN}/api/mobile/challenge`, `POST ${LAN}/api/mobile/session`,
          `POST ${LAN}/api/mobile/paths`, `GET ${LAN}/api/sessions`,
        ]);
        // Only the counts leave the main process, and nothing of a session is logged.
        expect(JSON.stringify(answers)).not.toContain('a private title');
        expect(logged.lines).toEqual([]);
      });

      it('says 0 when none of them waits', async () => {
        const id = await connected();
        share({ a: { status: 'working' }, b: { status: 'waiting' } });
        expect(await data(id)).toEqual({ state: 'online', via: 'lan', sharedSessions: 2, needsYou: 0, message: null });
        share({});
        expect(await data(id)).toEqual({ state: 'online', via: 'lan', sharedSessions: 0, needsYou: 0, message: null });
      });

      it.each<[string, unknown]>([
        ['text that is no JSON', '<html>'],
        ['a JSON string', '"sessions"'],
        ['a JSON number', '7'],
      ])('says null for both counts when the list is %s', async (_name, body) => {
        const id = await connected();
        share(body);
        expect(await data(id)).toEqual({ state: 'online', via: 'lan', sharedSessions: null, needsYou: null, message: null });
      });

      it('says null for both when the machine refuses the list', async () => {
        const id = await connected(); // the fixture's machine answers /api/sessions with a 404
        expect(await data(id)).toEqual({ state: 'online', via: 'lan', sharedSessions: null, needsYou: null, message: null });
      });

      it('with its window open, counts them with the window’s own session, again with no request added', async () => {
        const id = await connected();
        windows.openRemoteOrigin.mockReturnValue(LAN);
        windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
        w.net.at(LAN, sharing(async (req) => (req.path === '/api/auth/status'
          ? { status: 200, body: { passwordRequired: true, authenticated: true } } : w.lan.box(req)), SESSIONS));
        expect(await data(id)).toEqual({ state: 'online', via: 'lan', sharedSessions: 6, needsYou: 2, message: null });
        expect(requests()).toEqual([`GET ${LAN}/api/auth/status`, `GET ${LAN}/api/sessions`]);
      });

      it('says null while it waits for Allow, when nothing answers, and when the machine does not prove itself', async () => {
        const out = await connect();
        const id = out.ok ? out.data.id : '';
        share(SESSIONS);
        expect(await data(id)).toMatchObject({ state: 'pending', sharedSessions: null, needsYou: null });
        expect(calls('/api/sessions')).toEqual([]);
        allow();
        await check(id); // seen as allowed here: the record is active from now on
        w.net.calls.length = 0;
        w.net.at(LAN, null);
        w.net.at(TS, null);
        expect(await data(id)).toMatchObject({ state: 'offline', sharedSessions: null, needsYou: null });
        behindRelay();
        expect(await data(id)).toMatchObject({ state: 'offline', unproved: true, sharedSessions: null, needsYou: null });
        // No list was asked for in any of them.
        expect(calls('/api/sessions')).toEqual([]);
      });
    });

    describe('for a record paired by link', () => {
      const linked = () => w.lan.devices.find((d) => d.deviceId === LINK_DEVICE.deviceId)!;

      beforeEach(async () => {
        seedLinkRecord();
        await register();
      });

      it('counts them the same way, with the requests it made before', async () => {
        share(SESSIONS);
        expect(await data(LINK_ID)).toEqual({ state: 'online', via: 'lan', sharedSessions: 6, needsYou: 2, message: null });
        expect(requests()).toEqual([
          `POST ${LAN}/api/mobile/challenge`, `POST ${LAN}/api/mobile/session`, `POST ${LAN}/api/mobile/paths`, `GET ${LAN}/api/sessions`,
        ]);
      });

      it('with its window open, counts them with the window’s own session', async () => {
        windows.openRemoteOrigin.mockReturnValue(LAN);
        windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
        w.net.at(LAN, sharing(async (req) => (req.path === '/api/auth/status'
          ? { status: 200, body: { passwordRequired: true, authenticated: true } } : w.lan.box(req)), SESSIONS));
        expect(await data(LINK_ID)).toEqual({ state: 'online', via: 'lan', sharedSessions: 6, needsYou: 2, message: null });
        expect(requests()).toEqual([`GET ${LAN}/api/auth/status`, `GET ${LAN}/api/sessions`]);
      });

      it('says null for a record that is waiting for Allow, removed there, or offline', async () => {
        share(SESSIONS);
        linked().status = 'pending';
        expect(await data(LINK_ID)).toEqual({ state: 'pending', via: 'lan', sharedSessions: null, needsYou: null, message: expect.stringMatching(/^Waiting for Allow on Old NUC/) });
        linked().status = 'revoked';
        expect(await data(LINK_ID)).toMatchObject({ state: 'revoked', sharedSessions: null, needsYou: null });
        w.net.at(LAN, null);
        w.net.at(TS, null);
        expect(await data(LINK_ID)).toMatchObject({ state: 'offline', sharedSessions: null, needsYou: null });
        expect(calls('/api/sessions')).toEqual([]);
      });

      it('says null for both counts when the list can’t be read', async () => {
        share('<html>');
        expect(await data(LINK_ID)).toEqual({ state: 'online', via: 'lan', sharedSessions: null, needsYou: null, message: null });
      });
    });
  });

  // `unproved: true` tells the switcher that Connect would enroll again: an ACTIVE record made through the account, at
  // whose address something answered and nothing proved itself. It is on no other answer.
  describe('the check says when the machine did not prove itself', () => {
    const data = async (id: string) => {
      const out = await check(id);
      return out.ok ? out.data : null;
    };

    it.each<[string, () => void]>([
      ['a box passes everything on in the machine’s place', () => behindRelay()],
      ['the machine’s owner removed this computer there', () => { w.lan.devices.length = 0; }],
      ['the machine offers no proof at all', () => { w.net.at(LAN, withoutProof(w.lan.box)); w.net.at(TS, withoutProof(w.tailnet.box)); }],
      ['one address answers wrongly and the other is silent', () => { w.net.at(LAN, withoutProof(w.lan.box)); w.net.at(TS, null); }],
    ])('sets it for an active account record when %s', async (_name, arrange) => {
      const id = await connected();
      arrange();
      expect(await data(id)).toEqual({ state: 'offline', via: null, sharedSessions: null, needsYou: null, message: SOMETHING_ELSE, unproved: true });
      // It is what Connect goes by: the same record now enrolls again.
      expect((await list())[0]).toMatchObject({ id, status: 'active' });
    });

    it('never sets it for a record still waiting for Allow, though nothing verifies for it either', async () => {
      const out = await connect();
      const id = out.ok ? out.data.id : '';
      expect(await data(id)).toEqual({ state: 'pending', via: null, sharedSessions: null, needsYou: null, message: WAITING });
      expect(await data(id)).not.toHaveProperty('unproved');
      // Also with a box in the machine's place: a waiting record reads as waiting.
      behindRelay();
      expect(await data(id)).not.toHaveProperty('unproved');
      expect(await data(id)).toMatchObject({ state: 'pending' });
    });

    it('never sets it when nothing answered anywhere: that is plain offline', async () => {
      const id = await connected();
      w.net.at(LAN, null);
      w.net.at(TS, null);
      const out = await data(id);
      expect(out).toMatchObject({ state: 'offline', via: null });
      expect(out?.message).toMatch(/^No answer from 192\.168\.1\.20 or 100\.101\.102\.103/);
      expect(out).not.toHaveProperty('unproved');
    });

    it('never sets it on an online answer, with or without the computer’s window open', async () => {
      const id = await connected();
      expect(await data(id)).toMatchObject({ state: 'online', via: 'lan' });
      expect(await data(id)).not.toHaveProperty('unproved');
      windows.openRemoteOrigin.mockReturnValue(LAN);
      windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
      w.net.at(LAN, async (req) => (req.path === '/api/auth/status' ? { status: 200, body: { passwordRequired: true, authenticated: true } } : w.lan.box(req)));
      const open = await data(id);
      expect(open).toMatchObject({ state: 'online', via: 'lan' });
      expect(open).not.toHaveProperty('unproved');
    });

    it('never sets it on the open-window answer, where Connect would not enroll again', async () => {
      const id = await connected();
      // The window's own address is quiet and the other address fails the proof: offline in the usual words.
      windows.openRemoteOrigin.mockReturnValue(TS);
      windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
      w.net.at(TS, null);
      w.net.at(LAN, withoutProof(w.lan.box));
      const out = await data(id);
      expect(out).toMatchObject({ state: 'offline' });
      expect(out?.message).toMatch(/^No answer from/);
      expect(out).not.toHaveProperty('unproved');
    });

    describe('and never for a record paired by link', () => {
      const linked = () => w.lan.devices.find((d) => d.deviceId === LINK_DEVICE.deviceId)!;

      beforeEach(async () => {
        seedLinkRecord();
        await register();
      });

      it('online, even where the machine’s proof would be for another address', async () => {
        w.net.at(LAN, relayTo(w.net, TS));
        expect(await data(LINK_ID)).toMatchObject({ state: 'online', via: 'lan' });
        expect(await data(LINK_ID)).not.toHaveProperty('unproved');
      });

      it('revoked, which a link record still hears from the machine', async () => {
        linked().status = 'revoked';
        expect(await data(LINK_ID)).toEqual({ state: 'revoked', via: 'lan', sharedSessions: null, needsYou: null, message: 'Old NUC removed this computer. Remove it here and pair again.' });
        expect(await data(LINK_ID)).not.toHaveProperty('unproved');
      });

      it('waiting for Allow', async () => {
        linked().status = 'pending';
        expect(await data(LINK_ID)).toMatchObject({ state: 'pending', via: 'lan' });
        expect(await data(LINK_ID)).not.toHaveProperty('unproved');
      });

      it('offline', async () => {
        w.net.at(LAN, null);
        w.net.at(TS, null);
        expect(await data(LINK_ID)).toMatchObject({ state: 'offline' });
        expect(await data(LINK_ID)).not.toHaveProperty('unproved');
      });
    });
  });

  describe('for a record paired by link', () => {
    beforeEach(async () => {
      seedLinkRecord();
      await register();
    });

    // Decision, Nov 20: for a record paired by link, ask nothing and refuse nothing. These are the requests the
    // handlers made before plan 18, read off the code of that time.
    it('makes exactly the requests it made before this work: check, open, a dead window signed back in, Remove', async () => {
      const requests = () => w.net.calls.splice(0).map((c) => `${c.method} ${c.url}`);
      // No window open: a check signs in, asks for the Tailscale address and counts the shared sessions.
      await check(LINK_ID);
      expect(requests()).toEqual([
        `POST ${LAN}/api/mobile/challenge`, `POST ${LAN}/api/mobile/session`, `POST ${LAN}/api/mobile/paths`, `GET ${LAN}/api/sessions`,
      ]);
      // Open: a sign-in, then the window.
      await open(LINK_ID);
      expect(requests()).toEqual([`POST ${LAN}/api/mobile/challenge`, `POST ${LAN}/api/mobile/session`]);
      // Open again with the window there and its session dead: asked, then signed back in.
      windows.focusRemoteWindow.mockReturnValue(true);
      windows.openRemoteOrigin.mockReturnValue(LAN);
      await open(LINK_ID);
      expect(requests()).toEqual([`GET ${LAN}/api/auth/status`, `POST ${LAN}/api/mobile/challenge`, `POST ${LAN}/api/mobile/session`]);
      expect(windows.signBackIn).toHaveBeenCalledWith(LINK_ID, LAN, expect.any(String), 3600);
      // A check with the window open and signed in: asked with the window's own session, no sign-in.
      windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
      w.net.at(LAN, async (req) => (req.path === '/api/auth/status' ? { status: 200, body: { passwordRequired: true, authenticated: true } } : w.lan.box(req)));
      await check(LINK_ID);
      expect(requests()).toEqual([`GET ${LAN}/api/auth/status`, `GET ${LAN}/api/sessions`]);
      // Remove: a challenge and the unpair.
      await invoke('remote:remove', [LINK_ID]);
      expect(requests()).toEqual([`POST ${LAN}/api/mobile/challenge`, `POST ${LAN}/api/mobile/unpair`]);
    });

    it('opens as before at a machine too old to give a proof, and asks for none', async () => {
      w.net.at(LAN, async (req) => (req.path === '/api/mobile/identify' ? { status: 404, body: { error: 'Not found' } } : w.lan.box(req)));
      expect(await open(LINK_ID)).toEqual({ ok: true, data: null });
      expect(windows.openRemoteWindow).toHaveBeenCalledOnce();
      expect(w.net.calls.map((c) => c.path)).toEqual(['/api/mobile/challenge', '/api/mobile/session']);
    });

    // Today's behaviour, unchanged: a released machine's proof names its socket address, so behind a forwarded port
    // it is "wrong" for a record that works. A link record is never refused on it.
    it('opens as before where the machine’s proof would be for another address', async () => {
      w.net.at(LAN, relayTo(w.net, TS));
      expect(await open(LINK_ID)).toEqual({ ok: true, data: null });
      expect(windows.openRemoteWindow).toHaveBeenCalledOnce();
      expect(await check(LINK_ID)).toMatchObject({ ok: true, data: { state: 'online', via: 'lan' } });
      expect(calls('/api/mobile/identify')).toEqual([]);
    });

    it('with its window open, asks another address with the window’s session as before, with no proof', async () => {
      windows.openRemoteOrigin.mockReturnValue(TS);
      windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
      w.net.at(TS, null);
      w.net.at(LAN, (req) => (req.path === '/api/auth/status'
        ? { status: 200, body: { passwordRequired: true, authenticated: true } }
        : req.path === '/api/sessions' ? { status: 200, body: { a: {} } } : { status: 404, body: { error: 'Not found' } }));
      expect(await check(LINK_ID)).toEqual({ ok: true, data: { state: 'online', via: 'lan', sharedSessions: 1, needsYou: 0, message: null } });
      expect(calls('/api/mobile/identify')).toEqual([]);
    });

    it('signs a dead window back in at its own address as before, with no proof', async () => {
      windows.focusRemoteWindow.mockReturnValue(true);
      windows.openRemoteOrigin.mockReturnValue(LAN);
      // The window's address answers "signed out" and nothing else; the sign-in lands on Tailscale.
      w.net.at(LAN, (req) => (req.path === '/api/auth/status'
        ? { status: 200, body: { passwordRequired: true, authenticated: false } } : 'network-error'));
      await open(LINK_ID);
      expect(windows.signBackIn).toHaveBeenCalledWith(LINK_ID, LAN, expect.any(String), 3600);
      expect(calls('/api/mobile/identify')).toEqual([]);
    });
  });

  describe('with the computer’s window open', () => {
    it('does not hand the window’s session to another address that fails the proof', async () => {
      const id = await connected();
      // The window is on Tailscale, which went quiet; a box now sits at the home-network address.
      windows.openRemoteOrigin.mockReturnValue(TS);
      windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
      w.net.at(TS, null);
      w.net.at(LAN, () => ({ status: 200, body: { passwordRequired: true, authenticated: true } }));
      expect(await check(id)).toMatchObject({ ok: true, data: { state: 'offline' } });
      const withCookie = w.net.calls.filter((c) => c.headers.Cookie || c.headers.Authorization);
      expect(withCookie.map((c) => new URL(c.url).origin)).toEqual([TS]);
    });

    it('asks the other address with the window’s session once it proved itself', async () => {
      const id = await connected();
      windows.openRemoteOrigin.mockReturnValue(TS);
      windows.remoteSessionToken.mockResolvedValue('window-session-token-0123456789');
      w.net.at(TS, null);
      w.net.at(LAN, async (req) => (req.path === '/api/auth/status'
        ? { status: 200, body: { passwordRequired: true, authenticated: true } }
        : req.path === '/api/sessions' ? { status: 200, body: { a: {}, b: {} } } : w.lan.box(req)));
      expect(await check(id)).toEqual({ ok: true, data: { state: 'online', via: 'lan', sharedSessions: 2, needsYou: 0, message: null } });
    });

    it('does not sign a dead window back in at an address that fails the proof', async () => {
      const id = await connected();
      // The window is on the home network, where a box now answers "signed out"; the machine itself is on Tailscale.
      windows.focusRemoteWindow.mockReturnValue(true);
      windows.openRemoteOrigin.mockReturnValue(LAN);
      w.net.at(LAN, async (req) => {
        if (req.path === '/api/auth/status') return { status: 200, body: { passwordRequired: true, authenticated: false } };
        if (req.path === '/api/mobile/identify') return { status: 200, body: { success: true, data: { proof: '0'.repeat(64) } } };
        return 'network-error';
      });
      await open(id);
      expect(windows.signBackIn).not.toHaveBeenCalled();
    });

    it('signs a dead window back in at its own address when the machine proves itself there', async () => {
      const id = await connected();
      windows.focusRemoteWindow.mockReturnValue(true);
      windows.openRemoteOrigin.mockReturnValue(TS);
      w.net.at(LAN, null);
      w.net.at(TS, async (req) => (req.path === '/api/auth/status'
        ? { status: 200, body: { passwordRequired: true, authenticated: false } } : w.tailnet.box(req)));
      await open(id);
      expect(windows.signBackIn).toHaveBeenCalledWith(id, TS, expect.any(String), 3600);
    });
  });
});
