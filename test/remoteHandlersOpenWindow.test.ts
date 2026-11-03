// remoteHandlersOpenWindow.test.ts — what the remote:* handlers do once a computer's window is open. Every sign-in
// mints a session and the server keeps only the newest four per computer, so a Client's list checking on an open
// dashboard used to sign that dashboard out within two minutes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-test-path', isPackaged: false, on: vi.fn() },
  dialog: {},
  crashReporter: {},
  ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  safeStorage: { isEncryptionAvailable: () => true },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  shell: {},
}));

const COMPUTER = { id: 'abc', name: 'Studio', lan: '192.168.1.20', tailnet: null, port: 3334, status: 'active' };
const ORIGIN = 'http://192.168.1.20:3334';
const store = {
  get: vi.fn(() => COMPUTER),
  list: vi.fn(() => [COMPUTER]),
  credentials: vi.fn(() => ({ deviceId: 'd', deviceToken: 't' })),
  update: vi.fn(),
  remove: vi.fn(),
  canStore: () => true,
  add: vi.fn(),
};

vi.mock('../electron/remote/remoteStore.js', () => ({ createRemoteStore: () => store, REMOTE_ID: /^[a-z0-9-]+$/ }));

const client = vi.hoisted(() => ({
  signIn: vi.fn(),
  remoteSessionState: vi.fn(),
  fetchPaths: vi.fn(async () => null),
  countShared: vi.fn(async () => 3),
}));
vi.mock('../electron/remote/remoteClient.js', async (actual) => ({ ...await actual<object>(), ...client }));

const windows = vi.hoisted(() => ({
  focusRemoteWindow: vi.fn(() => false),
  openRemoteWindow: vi.fn(async () => undefined),
  forgetRemoteWindow: vi.fn(async () => undefined),
  openRemoteOrigin: vi.fn((): string | null => null),
  remoteSessionToken: vi.fn(async (): Promise<string | null> => 'cookie-token'),
  signBackIn: vi.fn(async () => undefined),
  closeRemoteWindows: vi.fn(),
  isLocalAppSenderUrl: () => true,
}));
vi.mock('../electron/remote/remoteWindow.js', () => windows);

const SIGNED_IN = { state: 'ok', token: 'fresh-token', expiresIn: 3600, origin: ORIGIN, via: 'lan' };
const fromApp = { senderFrame: { url: 'aasc-client://home/' } } as unknown as IpcMainInvokeEvent;

async function setUp(options: Record<string, unknown> = {}) {
  handlers.clear();
  vi.resetModules();
  const { registerRemoteHandlers, keepOpenWindowsSignedIn } = await import('../electron/ipc/remoteHandlers.js');
  registerRemoteHandlers({ isAppSender: () => true, ...options });
  return {
    check: () => handlers.get('remote:check')!(fromApp, 'abc') as Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }>,
    open: () => handlers.get('remote:open')!(fromApp, 'abc') as Promise<{ ok: boolean; error?: string }>,
    keepOpenWindowsSignedIn,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.signIn.mockResolvedValue(SIGNED_IN);
  client.remoteSessionState.mockResolvedValue('signed-in');
  windows.focusRemoteWindow.mockReturnValue(false);
  windows.openRemoteOrigin.mockReturnValue(null);
});

describe('checking on a computer', () => {
  it('signs in when no window is open, as ever', async () => {
    const { check } = await setUp({ keepSignedIn: true });
    const res = await check();
    expect(client.signIn).toHaveBeenCalledOnce();
    expect(res.data).toMatchObject({ state: 'online', via: 'lan', sharedSessions: 3 });
  });

  it('spends no session while its window is open', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    const { check } = await setUp({ keepSignedIn: true });
    for (let i = 0; i < 6; i++) await check();
    expect(client.signIn).not.toHaveBeenCalled();
    expect(client.fetchPaths).not.toHaveBeenCalled();
    expect(client.countShared).not.toHaveBeenCalled();
  });

  it('still tells the truth about it: online, and over which address', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    const { check } = await setUp({ keepSignedIn: true });
    expect((await check()).data).toEqual({ state: 'online', via: 'lan', sharedSessions: null, message: null });
  });

  it('still tells the truth about it: offline, with the reason', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('no-answer');
    const { check } = await setUp({ keepSignedIn: true });
    const { data } = await check();
    expect(data).toMatchObject({ state: 'offline', sharedSessions: null });
    expect(String(data?.message)).toMatch(/No answer from/);
  });

  it('reports a dead session as online: it answered, and keeping it signed in is another job', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('signed-out');
    const { check } = await setUp({ keepSignedIn: true });
    expect((await check()).data).toMatchObject({ state: 'online' });
    expect(client.signIn).not.toHaveBeenCalled();
  });

  it('is unchanged in Full and Lite, which pass nothing', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    const { check } = await setUp();
    await check();
    expect(client.signIn).toHaveBeenCalledOnce();
    expect(client.remoteSessionState).not.toHaveBeenCalled();
  });
});

describe('opening a computer', () => {
  it('hands a Client\'s UI to the new window, then says it opened', async () => {
    const beforeLoad = vi.fn();
    const onOpened = vi.fn();
    const { open } = await setUp({ beforeLoad, onOpened });
    expect((await open()).ok).toBe(true);
    expect(windows.openRemoteWindow).toHaveBeenCalledWith(expect.objectContaining({ id: 'abc', origin: ORIGIN, token: 'fresh-token', beforeLoad }));
    expect(onOpened).toHaveBeenCalledWith('abc');
  });

  it('says it opened when it only focused an open window, so the list still gets out of the way', async () => {
    windows.focusRemoteWindow.mockReturnValue(true);
    const onOpened = vi.fn();
    const { open } = await setUp({ onOpened });
    expect((await open()).ok).toBe(true);
    expect(onOpened).toHaveBeenCalledWith('abc');
    expect(windows.openRemoteWindow).not.toHaveBeenCalled();
  });

  it('opens one window when two asks arrive together', async () => {
    let finish: () => void = () => {};
    windows.openRemoteWindow.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    const { open } = await setUp();
    const both = [open(), open()];
    await vi.waitFor(() => expect(windows.openRemoteWindow).toHaveBeenCalledOnce());
    finish();
    expect((await Promise.all(both)).map((r) => r.ok)).toEqual([true, true]);
    expect(client.signIn).toHaveBeenCalledOnce();
    expect(windows.openRemoteWindow).toHaveBeenCalledOnce();
  });

  it('signs a dead dashboard back in rather than focusing a password form', async () => {
    windows.focusRemoteWindow.mockReturnValue(true);
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('signed-out');
    const { open } = await setUp({ keepSignedIn: true });
    expect((await open()).ok).toBe(true);
    expect(windows.signBackIn).toHaveBeenCalledWith('abc', ORIGIN, 'fresh-token', 3600);
  });

  it('leaves a live dashboard alone', async () => {
    windows.focusRemoteWindow.mockReturnValue(true);
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    const { open } = await setUp({ keepSignedIn: true });
    await open();
    expect(client.signIn).not.toHaveBeenCalled();
    expect(windows.signBackIn).not.toHaveBeenCalled();
  });

  it('never asks in Full and Lite, which pass nothing', async () => {
    windows.focusRemoteWindow.mockReturnValue(true);
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('signed-out');
    const { open } = await setUp();
    await open();
    expect(client.remoteSessionState).not.toHaveBeenCalled();
    expect(windows.signBackIn).not.toHaveBeenCalled();
  });
});

describe('keeping open dashboards signed in', () => {
  it('asks with the window\'s own cookie and spends nothing while the session lives', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    const { keepOpenWindowsSignedIn } = await setUp({ keepSignedIn: true });
    await keepOpenWindowsSignedIn();
    expect(client.remoteSessionState).toHaveBeenCalledWith(expect.anything(), ORIGIN, 'cookie-token');
    expect(client.signIn).not.toHaveBeenCalled();
    expect(windows.signBackIn).not.toHaveBeenCalled();
  });

  it('ignores a computer with no window', async () => {
    const { keepOpenWindowsSignedIn } = await setUp({ keepSignedIn: true });
    await keepOpenWindowsSignedIn();
    expect(client.remoteSessionState).not.toHaveBeenCalled();
    expect(client.signIn).not.toHaveBeenCalled();
  });

  // Tokens live only in the server's memory, so restarting the remote ends every session.
  it('signs back in when the session has died, on the window\'s own address', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('signed-out');
    client.signIn.mockResolvedValue({ ...SIGNED_IN, origin: 'http://100.64.0.20:3334', via: 'tailnet' });
    const { keepOpenWindowsSignedIn } = await setUp({ keepSignedIn: true });
    await keepOpenWindowsSignedIn();
    expect(windows.signBackIn).toHaveBeenCalledWith('abc', ORIGIN, 'fresh-token', 3600);
  });

  it('does nothing while the remote doesn\'t answer: the page\'s socket is already retrying', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('no-answer');
    const { keepOpenWindowsSignedIn } = await setUp({ keepSignedIn: true });
    await keepOpenWindowsSignedIn();
    expect(client.signIn).not.toHaveBeenCalled();
    expect(windows.closeRemoteWindows).not.toHaveBeenCalled();
  });

  it('leaves the window when the sign-in couldn\'t reach it after all', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('signed-out');
    client.signIn.mockResolvedValue({ state: 'offline', message: 'No answer' });
    const { keepOpenWindowsSignedIn } = await setUp({ keepSignedIn: true });
    await keepOpenWindowsSignedIn();
    expect(windows.signBackIn).not.toHaveBeenCalled();
    expect(windows.closeRemoteWindows).not.toHaveBeenCalled();
  });

  it('closes the dashboard when the remote removed this computer, so the list can say so', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockResolvedValue('signed-out');
    client.signIn.mockResolvedValue({ state: 'revoked', verified: true, origin: ORIGIN, via: 'lan' });
    const { keepOpenWindowsSignedIn } = await setUp({ keepSignedIn: true });
    await keepOpenWindowsSignedIn();
    expect(store.update).toHaveBeenCalledWith('abc', expect.objectContaining({ status: 'revoked' }));
    expect(windows.closeRemoteWindows).toHaveBeenCalledWith('abc');
  });

  it('never throws, so one bad computer can\'t stop the next round', async () => {
    windows.openRemoteOrigin.mockReturnValue(ORIGIN);
    client.remoteSessionState.mockRejectedValue(new Error('boom'));
    const { keepOpenWindowsSignedIn } = await setUp({ keepSignedIn: true });
    await expect(keepOpenWindowsSignedIn()).resolves.toBeUndefined();
  });
});
