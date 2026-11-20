// shortcutKeys.switchDevice.test.ts — the `switchDevice` key (plan 18 §5.4): ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere,
// and only in a window whose devices panel has the Switch part.
import { describe, it, expect, afterEach } from 'vitest';
import { hasAccountChannels } from './devicesSwitcher';
import { buildBindings, comboMatchesEvent, isMac, isTerminalPassThrough, keyComboToGlyphs, keyComboToString, SECTION_ORDER } from './shortcutKeys';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

/** The desktop app whose main process offers the account's computers. */
function withAccountChannels(): void {
  window.electronAPI = { remotes: { accountMachines: () => Promise.resolve({ ok: true, data: { state: 'signed-out' } }) } } as unknown as typeof window.electronAPI;
}

afterEach(() => {
  delete window.electronAPI;
});

const binding = () => buildBindings().find((b) => (b.actionId as string) === 'switchDevice');

describe('the switchDevice shortcut', () => {
  it('exists where the devices panel has the Switch part: the desktop app with the account channels', () => {
    withAccountChannels();
    expect(hasAccountChannels()).toBe(true);
    expect(binding()).toMatchObject({ label: 'Switch computer', section: 'Session Switch' });
    expect(SECTION_ORDER).toContain(binding()!.section);
  });

  it('is not offered anywhere else: a browser, a remote computer’s window, an app without the channels', () => {
    expect(hasAccountChannels()).toBe(false);
    expect(binding()).toBeUndefined();
    // A Client edition, or an app from before plan 18: remote computers, and no account channels.
    window.electronAPI = { remotes: { list: () => Promise.resolve([]) } } as unknown as typeof window.electronAPI;
    expect(hasAccountChannels()).toBe(false);
    expect(binding()).toBeUndefined();
  });

  it('is Cmd+Shift+S on a Mac and Ctrl+Shift+S elsewhere', () => {
    withAccountChannels();
    const combo = binding()!.combo;
    expect(combo).toEqual(isMac ? { key: 's', shiftKey: true, metaKey: true } : { key: 's', shiftKey: true, ctrlKey: true });
    expect(binding()!.defaultCombo).toEqual(combo);
    expect(keyComboToString(combo)).toBe(isMac ? 'Cmd+Shift+S' : 'Ctrl+Shift+S');
    expect(keyComboToGlyphs(combo, true)).toBe(isMac ? '⇧⌘S' : '⌃⇧S');
  });

  it('matches its own key, in either case, and nothing near it', () => {
    withAccountChannels();
    const combo = binding()!.combo;
    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    // A Mac reports "s" with Cmd held; Windows and Linux report "S" with Shift.
    expect(comboMatchesEvent(combo, key({ key: 's', shiftKey: true, ...mod }))).toBe(true);
    expect(comboMatchesEvent(combo, key({ key: 'S', shiftKey: true, ...mod }))).toBe(true);
    // Save, in the file editor.
    expect(comboMatchesEvent(combo, key({ key: 's', ...mod }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: 'S', shiftKey: true }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: 's', shiftKey: true, altKey: true, ...mod }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: 'd', shiftKey: true, ...mod }))).toBe(false);
  });

  it('shares its key with no other default', () => {
    withAccountChannels();
    const combos = buildBindings().filter((b) => b.combo).map((b) => JSON.stringify(b.combo));
    expect(combos).toContain(JSON.stringify(binding()!.combo));
    expect(new Set(combos).size).toBe(combos.length);
  });

  it('is a key a focused terminal hands to the app', () => {
    withAccountChannels();
    const combo = binding()!.combo!;
    const event = { metaKey: !!combo.metaKey, ctrlKey: !!combo.ctrlKey, altKey: !!combo.altKey, shiftKey: !!combo.shiftKey };
    expect(isTerminalPassThrough(event, isMac)).toBe(true);
  });

  it('keeps a key the person gave it', () => {
    withAccountChannels();
    const own = { key: 'F6' };
    const bound = buildBindings({ switchDevice: own } as never).find((b) => (b.actionId as string) === 'switchDevice');
    expect(bound?.combo).toEqual(own);
  });
});
