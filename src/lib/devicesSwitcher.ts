/**
 * devicesSwitcher — what the app's shortcut system and the devices panel share about the devices switcher (plan 18):
 * whether this window has one, and how the `switchDevice` key asks for it. Import-free, so `shortcutKeys` can read it.
 */

/**
 * Whether this window's devices panel has the Switch part: the desktop app, Full or Lite, whose main process offers
 * the account's computers. Not a browser, not a remote computer's window (no preload), not a Client edition.
 * A capability of the window, fixed for its life.
 */
export function hasAccountChannels(): boolean {
  return typeof window !== 'undefined' && typeof window.electronAPI?.remotes?.accountMachines === 'function';
}

/**
 * Dispatched on `document` by the `switchDevice` key: open the devices panel on Switch, or close it when it is open
 * there. The panel's own search field dispatches it too, since the app's shortcuts leave a text field its keys.
 */
export const DEVICES_SWITCH_EVENT = 'devicesPanel:switch';
