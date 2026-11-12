/**
 * phoneDownload — the phone file view's Download button (Nov 7 2026): save a project file onto the phone.
 *
 * The Mac's page is plain http inside the app, so the Web Share API is not there, and Capacitor's WebViews
 * save nothing on their own. So each place saves its own way:
 *   iOS app      posts to `aascSaveFile` (FileSaveBridge.swift): WebKit downloads it with the page's
 *                cookie, then the share sheet offers Save to Files / Save Video / AirDrop. The app answers
 *                with an `aasc-save-file` window event when the sheet opens or the download fails.
 *   Android app  an `<a download>` click; MainActivity's DownloadListener hands it to DownloadManager
 *                (the Downloads folder, with a system notification).
 *   a browser    the same `<a download>` click; the browser saves it.
 * An iOS app from before this build has no handler and its WebView would play the file in place of the
 * page, so it is told to update instead.
 */
import { nativeAppPlatform } from '@/lib/platform';
import { streamUrl } from '@/lib/phoneFiles';

export const SAVE_FILE_HANDLER = 'aascSaveFile';
export const SAVE_FILE_EVENT = 'aasc-save-file';

/** The whole file as an attachment: any type, no size cap (the route streams it). */
export function downloadUrl(root: string, path: string): string {
  return `${streamUrl(root, path)}&download=1`;
}

interface MessageHandler {
  postMessage(body: unknown): void;
}

function saveHandler(): MessageHandler | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, MessageHandler | undefined> } };
  return w.webkit?.messageHandlers?.[SAVE_FILE_HANDLER] ?? null;
}

/**
 * What a tap did: `native` = the iOS app is downloading and will answer with {@link SAVE_FILE_EVENT};
 * `browser` = handed to the browser or the Android app; `unsupported` = an iOS app too old to save.
 */
export type DownloadStart = 'native' | 'browser' | 'unsupported';

export function startDownload(url: string, name: string, id: string, userAgent?: string): DownloadStart {
  const handler = saveHandler();
  if (handler) {
    handler.postMessage({ id, url, name });
    return 'native';
  }
  if (nativeAppPlatform(userAgent) === 'ios') return 'unsupported';
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  return 'browser';
}

/** The iOS app's answer to one download. */
export interface SaveFileOutcome {
  id: string;
  state: 'shared' | 'failed';
  message?: string;
}

/** Reads an {@link SAVE_FILE_EVENT} detail; null for anything malformed. */
export function readSaveFileOutcome(detail: unknown): SaveFileOutcome | null {
  if (!detail || typeof detail !== 'object') return null;
  const { id, state, message } = detail as Record<string, unknown>;
  if (typeof id !== 'string' || (state !== 'shared' && state !== 'failed')) return null;
  return { id, state, ...(typeof message === 'string' && message ? { message: message.slice(0, 200) } : {}) };
}
