// remoteWindowSession.test.ts — a remote window's sign-in, against a fake Electron: reading its address and cookie
// without asking the server anything, signing it back in, and closing it.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fake = vi.hoisted(() => {
  const cookies = { set: vi.fn(async () => undefined), get: vi.fn(async (): Promise<Array<{ value: string }>> => []) };
  const ses = {
    cookies,
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(), on: vi.fn(),
  };
  return { ses, cookies, windows: [] as unknown[] };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => fake.windows },
  session: { fromPartition: () => fake.ses },
  shell: {},
}));

import { closeRemoteWindows, openRemoteOrigin, remoteSessionToken, signBackIn } from '../electron/remote/remoteWindow.js';

const ORIGIN = 'http://192.168.1.20:3334';
const win = (url: string, session: unknown = fake.ses) => ({
  isDestroyed: () => false,
  close: vi.fn(),
  webContents: { session, getURL: () => url, reload: vi.fn() },
});

beforeEach(() => {
  fake.windows.length = 0;
  vi.clearAllMocks();
});

describe('openRemoteOrigin', () => {
  it('is null with no window open', () => {
    expect(openRemoteOrigin('abc')).toBeNull();
  });

  it('is the address the window shows', () => {
    fake.windows.push(win(`${ORIGIN}/history?x=1`));
    expect(openRemoteOrigin('abc')).toBe(ORIGIN);
  });

  it('skips a window that hasn\'t loaded yet, or another computer\'s', () => {
    fake.windows.push(win(''), win('about:blank'), win('http://10.0.0.9:3334/', {}));
    expect(openRemoteOrigin('abc')).toBeNull();
    fake.windows.push(win(`${ORIGIN}/`));
    expect(openRemoteOrigin('abc')).toBe(ORIGIN);
  });
});

describe('remoteSessionToken', () => {
  it('reads the cookie for that address only', async () => {
    fake.cookies.get.mockResolvedValue([{ value: 'tok' }]);
    expect(await remoteSessionToken('abc', ORIGIN)).toBe('tok');
    expect(fake.cookies.get).toHaveBeenCalledWith({ url: `${ORIGIN}/`, name: 'auth_token' });
  });

  it('is null when there is none, or the session can\'t say', async () => {
    fake.cookies.get.mockResolvedValue([]);
    expect(await remoteSessionToken('abc', ORIGIN)).toBeNull();
    fake.cookies.get.mockRejectedValue(new Error('gone'));
    expect(await remoteSessionToken('abc', ORIGIN)).toBeNull();
  });
});

describe('signBackIn', () => {
  it('sets the same httpOnly cookie an open sets, then reloads this computer\'s windows only', async () => {
    const main = win(`${ORIGIN}/`);
    const popout = win(`${ORIGIN}/?popout=queue`);
    const other = win('http://10.0.0.9:3334/', {});
    fake.windows.push(main, popout, other);
    await signBackIn('abc', ORIGIN, 'fresh', 3600);
    expect(fake.cookies.set).toHaveBeenCalledWith(expect.objectContaining({
      url: `${ORIGIN}/`, name: 'auth_token', value: 'fresh', path: '/', httpOnly: true, sameSite: 'strict',
    }));
    expect(main.webContents.reload).toHaveBeenCalledOnce();
    expect(popout.webContents.reload).toHaveBeenCalledOnce();
    expect(other.webContents.reload).not.toHaveBeenCalled();
  });

  it('reloads only after the cookie is in', async () => {
    const main = win(`${ORIGIN}/`);
    fake.windows.push(main);
    let cookieIn = false;
    fake.cookies.set.mockImplementationOnce(async () => { await Promise.resolve(); cookieIn = true; return undefined; });
    main.webContents.reload.mockImplementation(() => expect(cookieIn).toBe(true));
    await signBackIn('abc', ORIGIN, 'fresh', 3600);
    expect(main.webContents.reload).toHaveBeenCalledOnce();
  });
});

describe('closeRemoteWindows', () => {
  it('closes this computer\'s windows only', () => {
    const mine = win(`${ORIGIN}/`);
    const other = win('http://10.0.0.9:3334/', {});
    fake.windows.push(mine, other);
    closeRemoteWindows('abc');
    expect(mine.close).toHaveBeenCalledOnce();
    expect(other.close).not.toHaveBeenCalled();
  });
});
