// clientMainWiring.test.ts — the Client's main process, against a fake Electron. Each thing here is a line whose
// deletion leaves the app starting and every other test green: the data folder, its own UI, home getting out of the way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const fake = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const app = {
    commandLine: { hasSwitch: vi.fn(() => false) },
    getPath: vi.fn(() => '/fake/appData'),
    setPath: vi.fn(),
    getAppPath: vi.fn(() => '/fake/app.asar'),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => listeners.set(name, listener)),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    exit: vi.fn(),
    quit: vi.fn(),
  };
  class FakeWindow {
    static all: FakeWindow[] = [];
    static getAllWindows = () => FakeWindow.all;
    static getFocusedWindow = () => null;
    hide = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    isMinimized = vi.fn(() => false);
    isDestroyed = vi.fn(() => false);
    isVisible = vi.fn(() => true);
    on = vi.fn();
    once = vi.fn();
    loadURL = vi.fn(async () => undefined);
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn(), send: vi.fn() };
    constructor() { FakeWindow.all.push(this); }
  }
  return { app, listeners, FakeWindow };
});

vi.mock('electron', () => ({
  app: fake.app,
  BrowserWindow: fake.FakeWindow,
  Menu: { buildFromTemplate: vi.fn(() => ({})), setApplicationMenu: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: { defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() } },
}));

const remote = vi.hoisted(() => ({
  registerRemoteHandlers: vi.fn(),
  keepOpenWindowsSignedIn: vi.fn(async () => undefined),
  serveBundledUi: vi.fn(async () => undefined),
}));
vi.mock('../electron/ipc/remoteHandlers.js', () => ({
  registerRemoteHandlers: remote.registerRemoteHandlers,
  keepOpenWindowsSignedIn: remote.keepOpenWindowsSignedIn,
}));
vi.mock('../electron/remote/clientUi.js', async (actual) => ({ ...await actual<object>(), serveBundledUi: remote.serveBundledUi }));
vi.mock('../electron/crashLogger.js', () => ({ initCrashLogger: vi.fn(), logMainError: vi.fn() }));
vi.mock('../electron/singleInstance.js', () => ({ claimSingleInstance: () => true, revealRunningWindow: () => undefined }));
vi.mock('../electron/clientEdition.js', async (actual) => ({ ...await actual<object>(), readClientEdition: () => 'full-client' }));

async function launch() {
  vi.resetModules();
  fake.FakeWindow.all = [];
  fake.listeners.clear();
  await import('../electron/clientMain.js');
  await vi.waitFor(() => expect(remote.registerRemoteHandlers).toHaveBeenCalled());
  const options = remote.registerRemoteHandlers.mock.calls[0][0] as Record<string, (...args: unknown[]) => unknown> & { keepSignedIn?: boolean };
  return { options, home: fake.FakeWindow.all[0] };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  fake.app.commandLine.hasSwitch.mockReturnValue(false);
});
afterEach(() => vi.useRealTimers());

describe('the data folder', () => {
  // A wrong folder would mean a Client sharing sessions.db and the single-instance lock with a local AASC.
  it('is the Client\'s own', async () => {
    await launch();
    expect(fake.app.setPath).toHaveBeenCalledWith('userData', path.join('/fake/appData', 'ai-agent-session-center-client'));
  });

  it('leaves a test\'s --user-data-dir alone', async () => {
    fake.app.commandLine.hasSwitch.mockImplementation((name: string) => name === 'user-data-dir');
    await launch();
    expect(fake.app.setPath).not.toHaveBeenCalled();
  });
});

describe('what it asks of the remote handlers', () => {
  it('accepts only its own home page', async () => {
    const { options } = await launch();
    expect(options.isAppSender('aasc-client://home/')).toBe(true);
    expect(options.isAppSender('http://localhost:3333/')).toBe(false);
  });

  it('serves its own UI on each computer\'s session, and closes only that computer\'s stale windows', async () => {
    const { options } = await launch();
    const ses = {};
    await options.beforeLoad(ses, 'http://192.168.1.20:3334');
    const [givenSession, origin, root, windows] = remote.serveBundledUi.mock.calls[0] as unknown as [unknown, string, string, () => unknown[]];
    expect(givenSession).toBe(ses);
    expect(origin).toBe('http://192.168.1.20:3334');
    expect(path.basename(root)).toBe('client');
    expect(windows()).toEqual(fake.FakeWindow.all);
  });

  it('asks to keep open dashboards signed in', async () => {
    const { options } = await launch();
    expect(options.keepSignedIn).toBe(true);
  });

  it('hides the list once a computer opens', async () => {
    const { options, home } = await launch();
    options.onOpened('abc');
    expect(home.hide).toHaveBeenCalledOnce();
  });
});

describe('keeping dashboards signed in', () => {
  it('asks again and again, each round after the last has finished', async () => {
    let finish: () => void = () => {};
    remote.keepOpenWindowsSignedIn.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finish = () => resolve(undefined); }));
    await launch();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remote.keepOpenWindowsSignedIn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(remote.keepOpenWindowsSignedIn).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(remote.keepOpenWindowsSignedIn).toHaveBeenCalledTimes(2);
  });
});

describe('clicking the Dock icon', () => {
  const activate = (hasVisibleWindows: boolean) => fake.listeners.get('activate')!({}, hasVisibleWindows);

  // macOS says a dashboard covered by another app is visible; Electron's isVisible() says it isn't.
  it('does nothing while a window is on screen, even one behind another app', async () => {
    const { home } = await launch();
    const dashboard = new fake.FakeWindow();
    dashboard.isVisible.mockReturnValue(false);
    home.show.mockClear();
    activate(true);
    expect(home.show).not.toHaveBeenCalled();
    expect(dashboard.show).not.toHaveBeenCalled();
  });

  it('brings a minimised dashboard back, not the list', async () => {
    const { home } = await launch();
    const dashboard = new fake.FakeWindow();
    dashboard.isMinimized.mockReturnValue(true);
    home.show.mockClear();
    activate(false);
    expect(dashboard.restore).toHaveBeenCalledOnce();
    expect(dashboard.focus).toHaveBeenCalledOnce();
    expect(home.show).not.toHaveBeenCalled();
  });

  it('shows the list when nothing else is open', async () => {
    const { home } = await launch();
    home.show.mockClear();
    activate(false);
    expect(home.show).toHaveBeenCalledOnce();
  });

  // A hidden window never hears it from Chromium: on macOS it stays "visible" and fires no visibilitychange.
  it('tells the list it is back, so it checks again', async () => {
    const { home } = await launch();
    expect(home.webContents.send).not.toHaveBeenCalled();
    activate(false);
    expect(home.webContents.send).toHaveBeenCalledWith('client:home-shown');
  });
});
