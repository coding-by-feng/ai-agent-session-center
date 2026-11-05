// serveBundledUi.test.ts — the Electron side of a Client's UI, against a fake session: the part that decides what a
// remote's partition answers, downloads and keeps when the computer's address changes.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow, Session } from 'electron';
import { serveBundledUi } from '../electron/remote/clientUi.js';

const LAN = 'http://192.168.1.20:3334';
const TAILNET = 'http://100.64.0.20:3334';

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'client-ui-'));
  writeFileSync(path.join(root, 'index.html'), '<head></head>BUNDLED');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function fakeSession(answer: () => Promise<Response> = async () => new Response('{}')) {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const ses = {
    protocol: { handle: vi.fn() },
    fetch: vi.fn(answer),
    on: vi.fn((name: string, listener: (...args: unknown[]) => void) => listeners.set(name, listener)),
    cookies: { remove: vi.fn(async () => undefined) },
  };
  const handler = () => ses.protocol.handle.mock.calls[0][1] as (request: Request) => Promise<Response>;
  const download = (url: string) => {
    const event = { preventDefault: vi.fn() };
    listeners.get('will-download')!(event, { getURL: () => url });
    return event.preventDefault.mock.calls.length === 0;
  };
  return { ses, session: ses as unknown as Session, handler, download };
}

const windowOn = (session: unknown) => ({ webContents: { session }, close: vi.fn(), isDestroyed: () => false });
const none = () => [] as unknown as BrowserWindow[];

describe('serveBundledUi', () => {
  it('registers once per session, however many times the computer opens', async () => {
    const { ses, session } = fakeSession();
    await serveBundledUi(session, LAN, root, none);
    await serveBundledUi(session, LAN, root, none);
    expect(ses.protocol.handle).toHaveBeenCalledTimes(1);
    expect(ses.protocol.handle.mock.calls[0][0]).toBe('http');
  });

  it('forwards through the session itself, past its own handler', async () => {
    const { ses, session, handler } = fakeSession();
    await serveBundledUi(session, LAN, root, none);
    await handler()(new Request(`${LAN}/api/sessions`));
    expect(ses.fetch.mock.calls[0][1]).toEqual({ bypassCustomProtocolHandlers: true });
  });

  it('checks the remote answers before giving a page, through the same session', async () => {
    const { ses, session, handler } = fakeSession();
    await serveBundledUi(session, LAN, root, none);
    expect(await (await handler()(new Request(`${LAN}/`))).text()).toContain('BUNDLED');
    const [url, init] = ses.fetch.mock.calls[0] as unknown as [string, { bypassCustomProtocolHandlers: boolean; signal: AbortSignal }];
    expect(url).toBe(`${LAN}/api/auth/status`);
    expect(init.bypassCustomProtocolHandlers).toBe(true);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('gives the offline page when the remote doesn\'t answer', async () => {
    const { session, handler } = fakeSession(async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); });
    await serveBundledUi(session, LAN, root, none);
    expect((await handler()(new Request(`${LAN}/`))).status).toBe(503);
  });

  describe('when the computer has moved to another address', () => {
    it('answers at the new one and refuses the old', async () => {
      const { ses, session, handler } = fakeSession();
      await serveBundledUi(session, LAN, root, none);
      await serveBundledUi(session, TAILNET, root, none);
      expect((await handler()(new Request(`${TAILNET}/`))).status).toBe(200);
      ses.fetch.mockClear();
      expect((await handler()(new Request(`${LAN}/`))).type).toBe('error');
      expect(ses.fetch).not.toHaveBeenCalled();
    });

    it('closes the windows left on the old one, which could only fail, and only this computer\'s', async () => {
      const { session } = fakeSession();
      const mine = windowOn(session);
      const other = windowOn({});
      await serveBundledUi(session, LAN, root, none);
      await serveBundledUi(session, TAILNET, root, () => [mine, other] as unknown as BrowserWindow[]);
      expect(mine.close).toHaveBeenCalledOnce();
      expect(other.close).not.toHaveBeenCalled();
    });

    // Someone else may hold that address next, and the old pop-out's socket would hand them the cookie.
    it('removes the sign-in cookie from the old one before the new one is set', async () => {
      const { ses, session } = fakeSession();
      let removed = false;
      ses.cookies.remove.mockImplementation(async () => { await Promise.resolve(); removed = true; });
      await serveBundledUi(session, LAN, root, none);
      await serveBundledUi(session, TAILNET, root, none);
      expect(ses.cookies.remove).toHaveBeenCalledWith(`${LAN}/`, 'auth_token');
      expect(removed).toBe(true);
    });

    it('still opens when that cookie can\'t be removed', async () => {
      const { ses, session } = fakeSession();
      ses.cookies.remove.mockRejectedValue(new Error('gone'));
      await serveBundledUi(session, LAN, root, none);
      await expect(serveBundledUi(session, TAILNET, root, none)).resolves.toBeUndefined();
    });

    it('does nothing when the address is the same one written differently', async () => {
      const { ses, session } = fakeSession();
      const mine = windowOn(session);
      await serveBundledUi(session, 'http://192.168.1.20:80', root, none);
      await serveBundledUi(session, 'http://192.168.1.20', root, () => [mine] as unknown as BrowserWindow[]);
      expect(mine.close).not.toHaveBeenCalled();
      expect(ses.cookies.remove).not.toHaveBeenCalled();
    });
  });

  describe('downloads', () => {
    it('lets the dashboard save its own files and nothing from anywhere else', async () => {
      const { session, download } = fakeSession();
      await serveBundledUi(session, LAN, root, none);
      expect(download(`${LAN}/api/files/stream?path=a.pdf`)).toBe(true);
      expect(download(`blob:${LAN}/0f1e`)).toBe(true);
      expect(download('https://evil.example/x.dmg')).toBe(false);
      expect(download('data:text/plain,x')).toBe(false);
    });

    it('follows the computer to its new address', async () => {
      const { session, download } = fakeSession();
      await serveBundledUi(session, LAN, root, none);
      await serveBundledUi(session, TAILNET, root, none);
      expect(download(`${TAILNET}/api/files/stream?path=a.pdf`)).toBe(true);
      expect(download(`${LAN}/api/files/stream?path=a.pdf`)).toBe(false);
    });
  });
});
