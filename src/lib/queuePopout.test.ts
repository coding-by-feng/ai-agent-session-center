import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openQueuePopout,
  queuePopoutUrl,
  queuePopoutWindowName,
  queuePopoutTitle,
  _resetQueuePopoutsForTests,
} from './queuePopout';

type ElectronBridge = NonNullable<Window['electronAPI']>;

function setElectronAPI(api: Partial<ElectronBridge> | undefined): void {
  Object.defineProperty(window, 'electronAPI', { value: api, configurable: true, writable: true });
}

describe('openQueuePopout', () => {
  let openSpy: ReturnType<typeof vi.fn>;
  /** A popup the way the browser hands one back: open, and focusable. */
  const newPopup = () => ({ closed: false, focus: vi.fn() }) as unknown as Window & { focus: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    openSpy = vi.fn(newPopup);
    vi.stubGlobal('open', openSpy);
  });

  afterEach(() => {
    setElectronAPI(undefined);
    _resetQueuePopoutsForTests();
    vi.unstubAllGlobals();
  });

  describe('under Electron', () => {
    it('hands the session to the native window and never touches window.open', async () => {
      const openQueueWindow = vi.fn(async () => ({ ok: true }));
      setElectronAPI({ openQueueWindow });

      const outcome = await openQueuePopout({ sessionId: 's-1', label: 'KTS Agent' });

      expect(outcome).toBe('native');
      expect(openQueueWindow).toHaveBeenCalledWith({ sessionId: 's-1', label: 'KTS Agent' });
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('does nothing with a preload that lacks the bridge, instead of leaving the app', async () => {
      // A stale preload is a build problem. Falling back to window.open would be worse than
      // useless here: the shell's window-open policy sends anything it cannot place to the
      // system browser, so it would pop Chrome open on localhost.
      setElectronAPI({});

      const outcome = await openQueuePopout({ sessionId: 's-1' });

      expect(outcome).toBe('unsupported');
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('treats a rejected IPC call as unsupported, still without window.open', async () => {
      setElectronAPI({ openQueueWindow: vi.fn(async () => { throw new Error('No handler registered'); }) });

      expect(await openQueuePopout({ sessionId: 's-1' })).toBe('unsupported');
      expect(openSpy).not.toHaveBeenCalled();
    });

    it('treats { ok: false } as unsupported', async () => {
      setElectronAPI({ openQueueWindow: vi.fn(async () => ({ ok: false })) });

      expect(await openQueuePopout({ sessionId: 's-1' })).toBe('unsupported');
    });
  });

  describe('in a plain browser', () => {
    it('opens the standalone queue route as a real popup window, named per session', async () => {
      const outcome = await openQueuePopout({ sessionId: 's-1' });

      expect(outcome).toBe('browser');
      expect(openSpy).toHaveBeenCalledTimes(1);
      const [url, name, features] = openSpy.mock.calls[0] as [string, string, string];
      expect(url).toBe('/?popout=queue&sessionId=s-1');
      expect(name).toBe(queuePopoutWindowName('s-1'));
      // A features string (with a size) is what makes the browser open a WINDOW, not a tab.
      expect(features).toMatch(/\bpopup\b/);
      expect(features).toMatch(/width=\d+/);
      expect(features).toMatch(/height=\d+/);
    });

    it('reports a blocked popup instead of pretending it opened', async () => {
      openSpy.mockReturnValue(null);

      expect(await openQueuePopout({ sessionId: 's-1' })).toBe('blocked');
    });

    describe('a second click on a queue that is already floated', () => {
      it('focuses the open window and does not call window.open again', async () => {
        // window.open(url, name) on an existing named window NAVIGATES it to the url again: the popup
        // reloads, and its unsent draft and any push still waiting out its debounce are gone.
        const popup = newPopup();
        openSpy.mockReturnValue(popup);

        expect(await openQueuePopout({ sessionId: 's-1' })).toBe('browser');
        expect(await openQueuePopout({ sessionId: 's-1' })).toBe('browser');

        expect(openSpy).toHaveBeenCalledTimes(1);
        expect(popup.focus).toHaveBeenCalledTimes(1);
      });

      it('opens a new window once the earlier one has been closed', async () => {
        const first = newPopup();
        const second = newPopup();
        openSpy.mockReturnValueOnce(first).mockReturnValueOnce(second);

        await openQueuePopout({ sessionId: 's-1' });
        (first as { closed: boolean }).closed = true;
        await openQueuePopout({ sessionId: 's-1' });

        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(first.focus).not.toHaveBeenCalled();
        // And the new one is the one remembered.
        await openQueuePopout({ sessionId: 's-1' });
        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(second.focus).toHaveBeenCalledTimes(1);
      });

      it('keeps one window per session', async () => {
        const a = newPopup();
        const b = newPopup();
        openSpy.mockReturnValueOnce(a).mockReturnValueOnce(b);

        await openQueuePopout({ sessionId: 's-1' });
        await openQueuePopout({ sessionId: 's-2' });
        await openQueuePopout({ sessionId: 's-1' });

        expect(openSpy).toHaveBeenCalledTimes(2);
        expect(a.focus).toHaveBeenCalledTimes(1);
        expect(b.focus).not.toHaveBeenCalled();
      });

      it('does not remember a popup the browser blocked', async () => {
        openSpy.mockReturnValueOnce(null);
        expect(await openQueuePopout({ sessionId: 's-1' })).toBe('blocked');

        // The user allows popups and clicks again: it must open, not "focus" nothing.
        expect(await openQueuePopout({ sessionId: 's-1' })).toBe('browser');
        expect(openSpy).toHaveBeenCalledTimes(2);
      });
    });
  });

  it('refuses an empty session id without opening anything', async () => {
    const openQueueWindow = vi.fn(async () => ({ ok: true }));
    setElectronAPI({ openQueueWindow });

    expect(await openQueuePopout({ sessionId: '' })).toBe('unsupported');
    expect(openQueueWindow).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe('queuePopoutTitle', () => {
  it('names the window after the session, the way every card in the app is named', () => {
    expect(queuePopoutTitle({ title: 'KTS Agent', projectName: 'kts' })).toBe('Queue — KTS Agent');
  });

  it('falls back through the project name, never to a bare "Queue — "', () => {
    // session.title stays empty until the first prompt; sessionDisplayTitle owns the fallback.
    expect(queuePopoutTitle({ title: '', projectName: 'kts' })).toBe('Queue — kts');
    expect(queuePopoutTitle(undefined)).toBe('Queue');
  });
});

describe('queuePopoutUrl / queuePopoutWindowName', () => {
  it('encodes the session id into the query string', () => {
    expect(queuePopoutUrl('a b/c?d')).toBe('/?popout=queue&sessionId=a%20b%2Fc%3Fd');
  });

  it('keeps one window name per session and strips characters a window name cannot carry', () => {
    expect(queuePopoutWindowName('a b/c?d')).toBe('aasc-queue-a_b_c_d');
    expect(queuePopoutWindowName('s-1')).toBe(queuePopoutWindowName('s-1'));
    expect(queuePopoutWindowName('s-1')).not.toBe(queuePopoutWindowName('s-2'));
  });
});
