// foregroundPolicy.ts — a notification that arrives while the app is open (AASC-19).
//
// Only called in the foreground (iOS willPresent / Android onMessageReceived,
// both surfaced as Capacitor's 'pushNotificationReceived'); in the background the
// OS shows the notification itself. The system banner is off in the foreground
// (capacitor.config.ts presentationOptions: []), so this decides alone:
//   - the user is looking at that very session  → nothing (they can see it)
//   - anything else                             → an in-app toast; tapping it opens the session
// No haptic here: haptics.ts reacts to the session's own state change, so the
// same event never buzzes twice.
import type { PushArrival, PushKind } from './pushPayload.js';
import { visibleText } from './pushPayload.js';

/** What the WebView shows right now, reported by the loaded UI (README "Native hooks"). */
export interface ViewState {
  serverId: string | null;
  sessionId: string | null;
}

export type ToastTone = 'attention' | 'success' | 'error' | 'info';

export type ForegroundDecision =
  | { show: 'none'; reason: 'viewing-session' | 'malformed' }
  | {
      show: 'toast';
      title: string;
      body: string;
      tone: ToastTone;
      durationMs: number;
      /** What tapping the toast opens (null for a test notification). */
      open: { sessionRef: string; kind: PushKind } | null;
    };

const TONE: Readonly<Record<PushKind, ToastTone>> = {
  approval: 'attention',
  input: 'attention',
  finished: 'success',
  interrupted: 'error',
  test: 'info',
};

/** Attention toasts stay longer: they ask for something. */
export const TOAST_MS = { attention: 8_000, other: 5_000 } as const;

/**
 * `arrivalServerId` is the Mac the shell resolved for the notification, or null
 * when it can't tell (several Macs, no hint); session ids are unique enough that
 * the same id on an unknown Mac counts as the same session.
 */
export function decideForeground(arrival: PushArrival | null, view: ViewState, arrivalServerId: string | null): ForegroundDecision {
  if (!arrival) return { show: 'none', reason: 'malformed' };
  if (arrival.kind !== 'test' && view.sessionId === arrival.sessionRef) {
    const sameMac = arrivalServerId === null || view.serverId === null || arrivalServerId === view.serverId;
    if (sameMac) return { show: 'none', reason: 'viewing-session' };
  }
  const { title, body } = visibleText(arrival);
  const tone = TONE[arrival.kind];
  return {
    show: 'toast',
    title,
    body,
    tone,
    durationMs: tone === 'attention' ? TOAST_MS.attention : TOAST_MS.other,
    open: arrival.kind === 'test' ? null : { sessionRef: arrival.sessionRef, kind: arrival.kind },
  };
}
