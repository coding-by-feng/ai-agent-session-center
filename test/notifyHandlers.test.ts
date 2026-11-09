// notifyHandlers.test.ts — app:notify (Nov 8 2026): the main window's system notification for a session that owes a
// "proceed" reply. Only the main window may ask, the text is clamped, and a click brings that window forward and
// tells it which session to open.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const shown: Array<{ opts: { title: string; body: string }; listeners: Map<string, () => void> }> = [];
let supported = true;

vi.mock('electron', () => {
  class Notification {
    static isSupported() { return supported; }
    listeners = new Map<string, () => void>();
    constructor(public opts: { title: string; body: string }) {}
    on(name: string, fn: () => void) { this.listeners.set(name, fn); return this; }
    show() { shown.push({ opts: this.opts, listeners: this.listeners }); }
  }
  return {
    ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
    Notification,
  };
});

function fakeWindow() {
  return {
    isDestroyed: () => false,
    isMinimized: vi.fn(() => true),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
}

let win: ReturnType<typeof fakeWindow>;
const fromMain = () => ({ sender: win.webContents }) as unknown as IpcMainInvokeEvent;
const notice = { sessionId: 'abc-123', title: 'KTS', body: 'Waiting for you to proceed' };

beforeEach(async () => {
  handlers.clear();
  shown.length = 0;
  supported = true;
  vi.resetModules();
  win = fakeWindow();
  const { registerNotifyHandlers } = await import('../electron/ipc/notifyHandlers.js');
  registerNotifyHandlers(() => win as never);
});

const call = (event: IpcMainInvokeEvent, input: unknown) => handlers.get('app:notify')!(event, input) as { ok: boolean };

describe('app:notify', () => {
  it('shows the title and body the main window sent', () => {
    expect(call(fromMain(), notice)).toEqual({ ok: true });
    expect(shown.map((n) => n.opts)).toEqual([expect.objectContaining({ title: 'KTS', body: 'Waiting for you to proceed' })]);
  });

  it('a click restores and focuses the main window and asks it to open that session', () => {
    call(fromMain(), notice);
    shown[0].listeners.get('click')!();
    expect(win.restore).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();
    expect(win.webContents.send).toHaveBeenCalledWith('app:open-session', 'abc-123');
  });

  it('refuses any other window (a pop-out, a remote computer)', () => {
    const other = { sender: { send: vi.fn() } } as unknown as IpcMainInvokeEvent;
    expect(call(other, notice)).toEqual({ ok: false });
    expect(shown).toHaveLength(0);
  });

  it.each([
    ['a session id with odd characters', { ...notice, sessionId: '../x' }],
    ['no title', { ...notice, title: '' }],
    ['not an object', 'hello'],
    ['a non-string body', { ...notice, body: 7 }],
  ])('refuses %s', (_name, input) => {
    expect(call(fromMain(), input)).toEqual({ ok: false });
    expect(shown).toHaveLength(0);
  });

  it('flattens control characters and clips long text', () => {
    call(fromMain(), { ...notice, title: `a\nb${'x'.repeat(200)}`, body: 'y'.repeat(300) });
    expect(shown[0].opts.title.startsWith('a b')).toBe(true);
    expect(shown[0].opts.title.length).toBeLessThanOrEqual(80);
    expect(shown[0].opts.body.length).toBeLessThanOrEqual(120);
  });

  it('answers ok: false where the system has no notifications', () => {
    supported = false;
    expect(call(fromMain(), notice)).toEqual({ ok: false });
  });
});
