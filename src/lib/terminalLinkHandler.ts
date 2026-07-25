import type { ILinkHandler } from '@xterm/xterm';

/**
 * Open a terminal hyperlink without letting xterm fall back to its built-in
 * confirmation dialog. Electron's setWindowOpenHandler routes this window.open
 * call to shell.openExternal; regular browsers keep the normal new-tab path.
 */
export function openTerminalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  } catch {
    return false;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/** Override xterm's default OSC 8 handler, which otherwise calls confirm(). */
export const TERMINAL_LINK_HANDLER: ILinkHandler = {
  activate(_event, url) {
    openTerminalUrl(url);
  },
  allowNonHttpProtocols: false,
};
