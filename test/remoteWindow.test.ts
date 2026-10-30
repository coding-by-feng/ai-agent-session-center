import { describe, it, expect, vi } from 'vitest';

// Only the pure helpers are under test; Electron itself never loads.
vi.mock('electron', () => ({ BrowserWindow: class {}, session: {}, shell: {} }));

const {
  remoteWindowWebPreferences, remotePartition, classifyRemoteUrl, remotePermissionAllowed,
  mayOpenRemoteWindow, mayOpenExternal, MAX_REMOTE_WINDOWS, EXTERNAL_OPEN_GAP_MS, isLocalAppSenderUrl, isPasteShortcut, attachPasteShortcut,
} = await import('../electron/remote/remoteWindow.js');

const ID = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const ORIGIN = 'http://192.168.1.20:3333';

describe('remoteWindowWebPreferences', () => {
  it('never gives a remote page a preload or Node', () => {
    const prefs = remoteWindowWebPreferences(ID);
    expect(prefs).not.toHaveProperty('preload');
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webviewTag).toBe(false);
    expect(prefs.webSecurity).toBe(true);
  });

  it('puts each remote in its own persistent partition', () => {
    const other = '9f1c2c7e-0000-4000-8000-000000000000';
    expect(remoteWindowWebPreferences(ID).partition).toBe(`persist:aasc-remote-${ID}`);
    expect(remoteWindowWebPreferences(ID).partition).toBe(remotePartition(ID));
    expect(remoteWindowWebPreferences(other).partition).not.toBe(remoteWindowWebPreferences(ID).partition);
    // Never the default session the local dashboard uses.
    expect(remoteWindowWebPreferences(ID).partition).toMatch(/^persist:aasc-remote-/);
  });
});

describe('classifyRemoteUrl', () => {
  it.each([
    [`${ORIGIN}/`],
    [`${ORIGIN}/history?x=1#frag`],
    [`${ORIGIN}/?popout=session&id=abc`],
  ])('keeps the remote’s own origin in the app: %s', (url) => {
    expect(classifyRemoteUrl(url, ORIGIN)).toBe('same-origin');
  });

  it.each([
    ['http://192.168.1.20:3000/', 'same host, other port'],
    ['https://192.168.1.20:3333/', 'same host and port, https'],
    ['http://192.168.1.21:3333/', 'other LAN host'],
    ['http://localhost:3333/', 'this computer’s own dashboard'],
    ['https://github.com/anthropics', 'a website'],
    ['http://192.168.1.20.evil.example:3333/', 'host merely starting with the remote’s'],
  ])('sends %s to the system browser (%s)', (url) => {
    expect(classifyRemoteUrl(url, ORIGIN)).toBe('external');
  });

  it.each([
    ['javascript:alert(1)'],
    ['file:///etc/passwd'],
    ['data:text/html,<script>1</script>'],
    [`blob:${ORIGIN}/0b7c`],
    ['ms-msdt:/id PCWDiagnostic'],
    ['vscode://file/etc/passwd'],
    ['about:blank'],
    ['not a url'],
    [''],
  ])('drops %s', (url) => {
    expect(classifyRemoteUrl(url, ORIGIN)).toBe('drop');
  });

  it('drops everything when the origin itself is malformed', () => {
    expect(classifyRemoteUrl(`${ORIGIN}/`, 'nope')).toBe('drop');
  });
});

describe('remotePermissionAllowed', () => {
  it('allows only a sanitized clipboard write', () => {
    expect(remotePermissionAllowed('clipboard-sanitized-write')).toBe(true);
    for (const p of ['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal', 'fullscreen', 'midi']) {
      expect(remotePermissionAllowed(p)).toBe(false);
    }
  });
});

describe('flood limits', () => {
  it('caps the windows one remote may hold open', () => {
    expect(mayOpenRemoteWindow(0)).toBe(true);
    expect(mayOpenRemoteWindow(MAX_REMOTE_WINDOWS - 1)).toBe(true);
    expect(mayOpenRemoteWindow(MAX_REMOTE_WINDOWS)).toBe(false);
  });

  it('lets a remote page reach the system browser at most once per gap', () => {
    expect(mayOpenExternal(undefined, 1_000)).toBe(true);
    expect(mayOpenExternal(1_000, 1_000 + EXTERNAL_OPEN_GAP_MS - 1)).toBe(false);
    expect(mayOpenExternal(1_000, 1_000 + EXTERNAL_OPEN_GAP_MS)).toBe(true);
  });
});

describe('isLocalAppSenderUrl', () => {
  it('accepts only the dashboard on this machine', () => {
    for (const u of ['http://localhost:3333/', 'http://localhost:3332/?popout=queue', 'http://127.0.0.1:3333/']) {
      expect(isLocalAppSenderUrl(u)).toBe(true);
    }
    for (const u of [`${ORIGIN}/`, 'https://localhost:3333/', 'http://localhost.evil.example/', 'file:///tmp/x.html', '', 'nope']) {
      expect(isLocalAppSenderUrl(u)).toBe(false);
    }
  });
});

describe('isPasteShortcut (a remote window turns ⌘V into a native paste)', () => {
  const key = (over: Partial<{ type: string; key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }>) =>
    ({ type: 'keyDown', key: 'v', meta: false, control: false, shift: false, alt: false, ...over });

  it('is ⌘V on macOS and Ctrl+V elsewhere, either case of V', () => {
    expect(isPasteShortcut(key({ meta: true }), 'darwin')).toBe(true);
    expect(isPasteShortcut(key({ meta: true, key: 'V' }), 'darwin')).toBe(true);
    expect(isPasteShortcut(key({ control: true }), 'linux')).toBe(true);
    expect(isPasteShortcut(key({ control: true }), 'win32')).toBe(true);
  });

  it('is nothing else: the other platform\'s modifier, Shift/Alt chords, key-up, other keys', () => {
    expect(isPasteShortcut(key({ control: true }), 'darwin')).toBe(false);
    expect(isPasteShortcut(key({ meta: true }), 'linux')).toBe(false);
    expect(isPasteShortcut(key({ meta: true, shift: true }), 'darwin')).toBe(false);
    expect(isPasteShortcut(key({ meta: true, alt: true }), 'darwin')).toBe(false);
    expect(isPasteShortcut(key({ meta: true, control: true }), 'darwin')).toBe(false);
    expect(isPasteShortcut(key({ meta: true, type: 'keyUp' }), 'darwin')).toBe(false);
    expect(isPasteShortcut(key({ meta: true, key: 'c' }), 'darwin')).toBe(false);
    expect(isPasteShortcut(key({}), 'darwin')).toBe(false);
  });

  it('the window turns the key into one native paste and keeps it from the page; nothing else', () => {
    let listener: ((event: { preventDefault(): void }, input: Parameters<typeof isPasteShortcut>[0]) => void) | null = null;
    const wc = { on: vi.fn((_name: string, l: typeof listener) => { listener = l; }), paste: vi.fn() };
    attachPasteShortcut(wc);
    expect(wc.on).toHaveBeenCalledWith('before-input-event', expect.any(Function));
    const fire = (input: ReturnType<typeof key>) => {
      const event = { preventDefault: vi.fn() };
      listener!(event, input);
      return event.preventDefault;
    };
    const paste = process.platform === 'darwin' ? { meta: true } : { control: true };
    expect(fire(key(paste))).toHaveBeenCalled();
    expect(wc.paste).toHaveBeenCalledTimes(1);
    expect(fire(key({ ...paste, type: 'keyUp' }))).not.toHaveBeenCalled();
    expect(fire(key({ ...paste, key: 'c' }))).not.toHaveBeenCalled();
    expect(wc.paste).toHaveBeenCalledTimes(1);
  });
});
