/**
 * What a paste into the terminal carries, read from the paste event itself.
 *
 * The terminal used to cancel the native paste on ⌘V / Ctrl+V and read the async Clipboard API instead. That API
 * exists only in a secure context and needs a permission, so in a paired remote computer's window (plain
 * `http://`, clipboard reads refused) and in any plain-HTTP tab nothing was pasted. A paste event's
 * `clipboardData` is always readable, because only the person's own keypress (or menu pick) makes one.
 */

export interface TerminalPaste {
  text: string;
  files: File[];
}

/**
 * The text and the files a paste event carries. Files win: they are uploaded and their saved paths typed
 * (lib/terminalFiles.ts). Any file counts, not only images (Nov 26 2026): a PDF or a `.md` copied in Finder too.
 */
export function readPasteData(data: DataTransfer | null): TerminalPaste {
  if (!data) return { text: '', files: [] };
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  return { text: data.getData('text/plain') ?? '', files };
}

/** A pasted line must not submit itself: trailing line breaks are dropped. */
export function stripTrailingNewlines(text: string): string {
  return text.replace(/[\r\n]+$/, '');
}

/** The keys `isPasteKey` reads off a keydown. */
export interface PasteKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * ⌘V on macOS, Ctrl+V elsewhere (either case of V). On macOS Ctrl+V is not a paste: it reaches the PTY as `^V`
 * (a shell's quoted insert, Claude Code's own image paste). The remote window uses the same rule
 * (`isPasteShortcut`, electron/remote/remoteWindow.ts).
 */
export function isPasteKey(e: PasteKey, mac: boolean): boolean {
  if (e.key.toLowerCase() !== 'v' || e.shiftKey || e.altKey) return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
