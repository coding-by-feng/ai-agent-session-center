// shareFlow.ts — the shell's side of "Share to AASC" (AASC-21 M5): which sessions the item can go
// to, and sending it (shareToQueue.ts cleans, strips metadata and enforces the limits; the Mac
// adds it paused). The session token from signing in is used for the listing and dropped.
import { openSession } from './pairingClient.js';
import { forgetMac, reach } from './shellFlows.js';
import type { RawShare, ShellDeps } from './native.js';
import { readMacCredentials, type SavedMac } from './savedMacs.js';
import { listSessions, type SessionLite } from './sessions.js';
import { SHARE_MESSAGES, shareTargets, shareToQueue, type ShareResult, type ShareTarget } from './shareToQueue.js';
import { buildWidgetModel, serializeWidgetModel } from './widgetModel.js';

/** Preferences: the session shared to last (an id, nothing secret), offered first next time. */
export const LAST_SHARE_TARGET_KEY = 'aasc.share.lastTarget';

/** What the native inbox refused before reading everything, in the shell's own words. */
const NATIVE_PROBLEM: Readonly<Record<string, string>> = {
  'too-many': 'At most 4 images. Nothing was added.',
  'text-too-long': 'Too long for a queue (the limit is 64 KB). Nothing was added.',
  'too-large': 'An image is larger than about 2 MB. Nothing was added.',
  unsupported: 'Only PNG, JPEG, WebP and GIF images can be added. Nothing was added.',
  unreadable: "An image couldn't be read. Nothing was added.",
};

export function shareProblem(share: RawShare): string | null {
  if (!share.problem) return null;
  return NATIVE_PROBLEM[share.problem] ?? "That couldn't be shared. Nothing was added.";
}

/** One line about what is being shared, for the screen. */
export function sharePreview(share: RawShare): string {
  const images = share.images?.length ?? 0;
  const text = (share.text ?? '').replace(/\s+/g, ' ').trim();
  const head = text.length > 140 ? `${text.slice(0, 139)}…` : text;
  const pics = images === 0 ? '' : images === 1 ? '1 image' : `${images} images`;
  return [head && `“${head}”`, pics].filter(Boolean).join(' + ') || 'Nothing';
}

export type TargetsResult =
  | { ok: true; origin: string; targets: ShareTarget[] }
  | { ok: false; message: string; macs?: SavedMac[] };

/** Reach the Mac, sign in, list the sessions it shares with this phone (and refresh the widget). */
export async function loadShareTargets(deps: ShellDeps, macs: readonly SavedMac[], mac: SavedMac): Promise<TargetsResult> {
  const reached = await reach(deps, mac);
  if (!reached) return { ok: false, message: SHARE_MESSAGES.offline };
  const creds = await readMacCredentials(deps.vault, mac.id).catch(() => null);
  if (!creds) return { ok: false, message: SHARE_MESSAGES.unpaired, macs: await forgetMac(deps, macs, mac) };
  const session = await openSession(deps.http, reached.origin, creds);
  if (session.status === 'pending') return { ok: false, message: SHARE_MESSAGES.pending };
  if (session.status === 'revoked') return { ok: false, message: SHARE_MESSAGES.unpaired, macs: await forgetMac(deps, macs, mac) };
  if (session.status !== 'ok') return { ok: false, message: SHARE_MESSAGES.offline };
  const listed = await listSessions(deps.requester, reached.origin, session.token);
  if (listed.status !== 'ok') return { ok: false, message: SHARE_MESSAGES.offline };
  await updateWidget(deps, listed.sessions);
  const preferred = await deps.store.get(LAST_SHARE_TARGET_KEY);
  return { ok: true, origin: reached.origin, targets: shareTargets(listed.sessions, preferred) };
}

export async function sendShare(deps: ShellDeps, mac: SavedMac, origin: string, sessionId: string, share: RawShare): Promise<ShareResult> {
  const result = await shareToQueue(share.text ?? null, sessionId, {
    http: deps.requester,
    origin,
    signIn: async (o) => {
      const creds = await readMacCredentials(deps.vault, mac.id).catch(() => null);
      return creds ? openSession(deps.http, o, creds) : { status: 'revoked' };
    },
  }, share.images ?? []);
  if (result.status === 'added') await deps.store.set(LAST_SHARE_TARGET_KEY, sessionId);
  return result;
}

/** The widget follows any session list the shell sees (titles on: they are this phone's own sessions). */
export async function updateWidget(deps: ShellDeps, sessions: readonly SessionLite[], now = Date.now()): Promise<void> {
  if (!deps.widget) return;
  await deps.widget.write(serializeWidgetModel(buildWidgetModel(sessions, now, { showTitles: true }))).catch(() => undefined);
}
