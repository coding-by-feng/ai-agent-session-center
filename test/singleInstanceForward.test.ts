// singleInstanceForward.test.ts — a second launch never takes the keyboard from the app the user is typing in (Nov 10
// 2026: something started AASC again while the user typed elsewhere; showRunningWindow stole focus and the keys went
// into a session's terminal). On macOS the running window comes back without activating, and the Dock icon bounces.
import { describe, expect, it, vi } from 'vitest';
import { revealRunningWindow, type RevealableWindow } from '../electron/singleInstance.js';

function fakeWindow(state: { minimized?: boolean; visible?: boolean; destroyed?: boolean } = {}) {
  const calls: string[] = [];
  const win: RevealableWindow = {
    isDestroyed: () => state.destroyed ?? false,
    isMinimized: () => state.minimized ?? false,
    isVisible: () => state.visible ?? true,
    restore: () => { calls.push('restore'); },
    show: () => { calls.push('show'); },
    showInactive: () => { calls.push('showInactive'); },
    focus: () => { calls.push('focus'); },
  };
  return { win, calls };
}

describe('revealRunningWindow', () => {
  it('macOS: a hidden window comes back behind the current app, and the Dock icon bounces', () => {
    const { win, calls } = fakeWindow({ visible: false });
    const bounce = vi.fn();
    revealRunningWindow(win, 'darwin', bounce);
    expect(calls).toEqual(['showInactive']);
    expect(bounce).toHaveBeenCalledOnce();
  });

  it('macOS: never focuses, restores or steals, whatever the window state', () => {
    for (const state of [{ visible: true }, { minimized: true, visible: true }]) {
      const { win, calls } = fakeWindow(state);
      const bounce = vi.fn();
      revealRunningWindow(win, 'darwin', bounce);
      expect(calls).not.toContain('focus');
      expect(calls).not.toContain('show');
      expect(calls).not.toContain('restore');
      expect(bounce).toHaveBeenCalledOnce();
    }
  });

  it('Windows and Linux keep bringing it forward (the system there only flashes the taskbar)', () => {
    const { win, calls } = fakeWindow({ minimized: true });
    revealRunningWindow(win, 'win32', vi.fn());
    expect(calls).toEqual(['restore', 'show', 'focus']);
  });

  it('does nothing for a closed window', () => {
    const { win, calls } = fakeWindow({ destroyed: true });
    const bounce = vi.fn();
    revealRunningWindow(win, 'darwin', bounce);
    expect(calls).toEqual([]);
    expect(bounce).not.toHaveBeenCalled();
  });
});
