// popoutTerminalWindow.test.ts — the one branch point that decides whether a
// floating AI session lands in a real OS window or falls back to the in-app
// docked panel.
//
// The load-bearing rule under test is the FALLBACK, not the happy path: the
// session is created server-side BEFORE any window exists, so a `docked`
// outcome that the caller ignores leaves a live forked CLI session holding a
// WebSocket subscription with no UI attached to it. Every branch that cannot
// produce a window must therefore say so, rather than failing silently.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openFloatWindow, openTerminalPopupFallback, preopenTerminalPopup } from './popoutTerminalWindow';

const OPTS = { terminalId: 'term-abc-123', originSessionId: 'sess-1', label: 'EXPLAIN (ENGLISH)' };

/** A minimal stand-in for the Window handle preopenTerminalPopup returns —
 *  tracks .close() calls and every value assigned to .location.href, which is
 *  exactly the surface openFloatWindow's preopened-window branch touches. */
function fakePreopenedWindow(): Window & { closeCalls: number; hrefAssignments: string[] } {
  let closed = false;
  const hrefAssignments: string[] = [];
  const win = {
    get closed() { return closed; },
    close: () => { closed = true; win.closeCalls++; },
    closeCalls: 0,
    location: {
      set href(v: string) { hrefAssignments.push(v); },
      get href() { return hrefAssignments.at(-1) ?? ''; },
    },
    hrefAssignments,
  };
  return win as unknown as Window & { closeCalls: number; hrefAssignments: string[] };
}

let originalOpen: typeof window.open;

beforeEach(() => {
  originalOpen = window.open;
  // jsdom has no real screen sizing; give the centering math something stable.
  Object.defineProperty(window, 'screen', {
    value: { availWidth: 1920, availHeight: 1080 },
    configurable: true,
  });
});

afterEach(() => {
  window.open = originalOpen;
  delete (window as { electronAPI?: unknown }).electronAPI;
  vi.restoreAllMocks();
});

describe('openFloatWindow — Electron with a working preload', () => {
  it('opens a native window via IPC and reports it placed', async () => {
    const openTerminalWindow = vi.fn().mockResolvedValue({ ok: true });
    (window as { electronAPI?: unknown }).electronAPI = { openTerminalWindow };
    const spy = vi.fn();
    window.open = spy as unknown as typeof window.open;

    await expect(openFloatWindow(OPTS)).resolves.toEqual({ placed: 'window' });
    expect(openTerminalWindow).toHaveBeenCalledWith(OPTS);
    // Must NOT also fire a browser popup.
    expect(spy).not.toHaveBeenCalled();
  });

  it('closes a preopened placeholder — the real window comes from IPC, not it', async () => {
    (window as { electronAPI?: unknown }).electronAPI = {
      openTerminalWindow: vi.fn().mockResolvedValue({ ok: true }),
    };
    const preopened = fakePreopenedWindow();

    await openFloatWindow({ ...OPTS, preopened });

    expect(preopened.closeCalls).toBe(1);
  });

  it('docks when the IPC call reports failure', async () => {
    (window as { electronAPI?: unknown }).electronAPI = {
      openTerminalWindow: vi.fn().mockResolvedValue({ ok: false }),
    };
    await expect(openFloatWindow(OPTS)).resolves.toEqual({
      placed: 'docked',
      reason: 'ipc-failed',
    });
  });

  it('docks when the IPC call rejects, rather than throwing at the caller', async () => {
    // A throw here would escape into SelectionPopup's catch and be shown as a
    // spawn error, even though the session spawned fine — the user would retry
    // and get a SECOND live session.
    (window as { electronAPI?: unknown }).electronAPI = {
      openTerminalWindow: vi.fn().mockRejectedValue(new Error('no handler')),
    };
    await expect(openFloatWindow(OPTS)).resolves.toEqual({
      placed: 'docked',
      reason: 'ipc-failed',
    });
  });
});

describe('openFloatWindow — Electron with a stale preload', () => {
  it('docks and NEVER calls window.open', async () => {
    // The critical one. Per attachWindowOpenPolicy, an unrecognized window.open
    // of our own origin escapes to the user's SYSTEM BROWSER on localhost.
    // A stale preload is a build problem; launching Chrome is not a graceful
    // degradation of it.
    (window as { electronAPI?: unknown }).electronAPI = { someOtherApi: () => {} };
    const spy = vi.fn();
    window.open = spy as unknown as typeof window.open;

    await expect(openFloatWindow(OPTS)).resolves.toEqual({
      placed: 'docked',
      reason: 'stale-preload',
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('also closes a preopened placeholder here — same "nothing must be left stranded" rule', async () => {
    (window as { electronAPI?: unknown }).electronAPI = { someOtherApi: () => {} };
    const preopened = fakePreopenedWindow();

    await openFloatWindow({ ...OPTS, preopened });

    expect(preopened.closeCalls).toBe(1);
  });
});

describe('openFloatWindow — plain browser', () => {
  it('opens a detached popup and reports it placed', async () => {
    const fakeWin = {} as Window;
    const spy = vi.fn().mockReturnValue(fakeWin);
    window.open = spy as unknown as typeof window.open;

    await expect(openFloatWindow(OPTS)).resolves.toEqual({ placed: 'window' });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, name, features] = spy.mock.calls[0] as [string, string, string];
    expect(url).toContain('popout=terminal');
    expect(url).toContain(`terminalId=${encodeURIComponent(OPTS.terminalId)}`);
    // `popup` in the features string is what makes it a real detached window
    // (draggable to another monitor) instead of a new tab.
    expect(features).toContain('popup');
    // Deterministic name => a second call focuses the existing popup.
    expect(name).toBe('aasc-terminal-term_abc_123');
  });

  it('docks when the popup is blocked (window.open returns null)', async () => {
    window.open = vi.fn().mockReturnValue(null) as unknown as typeof window.open;
    await expect(openFloatWindow(OPTS)).resolves.toEqual({
      placed: 'docked',
      reason: 'popup-blocked',
    });
  });
});

describe('openFloatWindow — plain browser, with a preopened window', () => {
  // This is the actual fix: SelectionPopup.spawn() used to await the spawn API
  // call BEFORE its only window.open(), which reliably got popup-blocked —
  // forking a session is a real network round trip, not instant, so Chrome's
  // transient-activation window had already expired by the time it ran. A
  // window opened synchronously (preopenTerminalPopup, tested separately
  // below) and handed in here must be NAVIGATED, not reopened, and that
  // navigation must never itself call window.open — it isn't subject to the
  // same blocking rule, which is the entire point.
  it('navigates the preopened window instead of calling window.open again', async () => {
    const spy = vi.fn();
    window.open = spy as unknown as typeof window.open;
    const preopened = fakePreopenedWindow();

    await expect(openFloatWindow({ ...OPTS, preopened })).resolves.toEqual({ placed: 'window' });

    expect(spy).not.toHaveBeenCalled();
    expect(preopened.closeCalls).toBe(0); // consumed as the real window, not closed
    expect(preopened.hrefAssignments).toHaveLength(1);
    // Parsed rather than substring-matched: URLSearchParams encodes a space as
    // `+`, not encodeURIComponent's `%20` — a raw .toContain() on the encoded
    // form would be asserting the wrong encoding, not the actual param value.
    const params = new URL(preopened.hrefAssignments[0], 'http://x').searchParams;
    expect(params.get('popout')).toBe('terminal');
    expect(params.get('terminalId')).toBe(OPTS.terminalId);
    expect(params.get('label')).toBe(OPTS.label);
  });

  it('falls back to a fresh window.open when the preopened window was closed by the user', async () => {
    const fakeWin = {} as Window;
    const spy = vi.fn().mockReturnValue(fakeWin);
    window.open = spy as unknown as typeof window.open;
    const preopened = fakePreopenedWindow();
    preopened.close(); // user closed the loading placeholder before spawn resolved

    await expect(openFloatWindow({ ...OPTS, preopened })).resolves.toEqual({ placed: 'window' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(preopened.hrefAssignments).toHaveLength(0); // never navigated a dead window
  });

  it('falls back to a fresh window.open when no preopened window was given (unchanged path)', async () => {
    const fakeWin = {} as Window;
    const spy = vi.fn().mockReturnValue(fakeWin);
    window.open = spy as unknown as typeof window.open;

    await expect(openFloatWindow({ ...OPTS, preopened: null })).resolves.toEqual({ placed: 'window' });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('docks if even the fresh fallback window.open is blocked after a closed preopened window', async () => {
    window.open = vi.fn().mockReturnValue(null) as unknown as typeof window.open;
    const preopened = fakePreopenedWindow();
    preopened.close();

    await expect(openFloatWindow({ ...OPTS, preopened })).resolves.toEqual({
      placed: 'docked',
      reason: 'popup-blocked',
    });
  });
});

describe('preopenTerminalPopup', () => {
  it('opens synchronously via window.open, with the popup features string', () => {
    const fakeWin = {} as Window;
    const spy = vi.fn().mockReturnValue(fakeWin);
    window.open = spy as unknown as typeof window.open;

    const result = preopenTerminalPopup();

    expect(result).toBe(fakeWin);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, name, features] = spy.mock.calls[0] as [string, string, string];
    // A data: URL — renders instantly, no network round trip, so there is
    // never a flash of true blank-white while the real spawn is in flight.
    expect(url).toMatch(/^data:text\/html,/);
    expect(features).toContain('popup');
    // NOT terminalId-based (unknown at this point) — must still be
    // collision-safe across concurrent preopens from different popups.
    expect(name).toMatch(/^aasc-terminal-pending-/);
  });

  it('two calls get two distinct window names', () => {
    const spy = vi.fn().mockReturnValue({} as Window);
    window.open = spy as unknown as typeof window.open;

    preopenTerminalPopup();
    preopenTerminalPopup();

    const [, name1] = spy.mock.calls[0] as [string, string, string];
    const [, name2] = spy.mock.calls[1] as [string, string, string];
    expect(name1).not.toBe(name2);
  });

  it('returns null when the browser blocks even the synchronous open', () => {
    window.open = vi.fn().mockReturnValue(null) as unknown as typeof window.open;
    expect(preopenTerminalPopup()).toBeNull();
  });

  it('the placeholder HTML embeds a title and is fully self-contained (no external requests)', () => {
    const spy = vi.fn().mockReturnValue({} as Window);
    window.open = spy as unknown as typeof window.open;

    preopenTerminalPopup();

    const [url] = spy.mock.calls[0] as [string];
    const html = decodeURIComponent(url.slice('data:text/html,'.length));
    expect(html).toContain('<title>');
    expect(html).not.toMatch(/https?:\/\//); // no CDN/asset references
  });
});

describe('openTerminalPopupFallback — returns the window handle', () => {
  it('propagates null so callers can detect a blocked popup', () => {
    window.open = vi.fn().mockReturnValue(null) as unknown as typeof window.open;
    expect(openTerminalPopupFallback(OPTS)).toBeNull();
  });

  it('omits optional params from the query string when absent', () => {
    const spy = vi.fn().mockReturnValue({} as Window);
    window.open = spy as unknown as typeof window.open;
    openTerminalPopupFallback({ terminalId: 'term-x' });
    const [url] = spy.mock.calls[0] as [string];
    expect(url).not.toContain('originSessionId');
    expect(url).not.toContain('label');
  });
});
