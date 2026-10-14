// pushNotifier.ts — turn session updates into phone notifications (AASC-16, Mac side).
//
// Listens to every session_update broadcast (wsManager.onBroadcast), applies
// pushRules, waits out the settle time, then re-reads the LIVE session: the rule
// decided whether to schedule, the live state decides whether to send.
//
// Sent only for sessions shared to remote devices — a notification must never
// reveal a hidden session (the seventh leak path next to the list, snapshot,
// broadcasts, /sessions/:id, TERMINAL_SUBSCRIBE and /db). Never carries prompt or
// response text or a command line: title and tool name only.
//
// The sink (the AASC backend's POST /v1/push/notify, through the cloud
// connector) is resolved per send; with no backend connected nothing is sent.

import { randomUUID } from 'crypto';
import type { Session } from '../../src/types/session.js';
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import {
  decidePush, settleMs, cooldownMs, stillApplies, ttlSeconds,
  type PushKind, type PushView,
} from './pushRules.js';

export interface PushMessage {
  mutationId: string;
  kind: PushKind;
  sessionRef: string;
  title: string;
  toolName?: string;
  collapseKey: string;
  ttlSeconds: number;
}

export interface PushSink {
  notify(message: PushMessage): Promise<void>;
}

export interface PushNotifierDeps {
  getSession(sessionId: string): Session | null | undefined;
  /** Visibility rule for remote devices (canSeeSession(false, …)). */
  canNotify(session: Session): boolean;
  /** The backend sink, or null when no backend is connected. */
  sink(): PushSink | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onError?: (message: string) => void;
}

const TITLE_MAX = 80;
const TOOL_MAX = 40;
const SESSION_REF = /^[A-Za-z0-9_-]{1,64}$/;

function viewOf(session: Session): PushView {
  return {
    status: session.status,
    approvalSource: session.approvalSource ?? null,
    hasInterruption: Boolean(session.interruption),
  };
}

function cleanText(raw: string, max: number): string {
  return raw.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The message for a session, or null when it can't be expressed safely. */
export function buildPushMessage(kind: PushKind, session: Session, mutationId: string): PushMessage | null {
  if (!SESSION_REF.test(session.sessionId)) return null;
  const message: PushMessage = {
    mutationId,
    kind,
    sessionRef: session.sessionId,
    title: cleanText(sessionDisplayTitle(session), TITLE_MAX) || 'Session',
    collapseKey: session.sessionId.slice(0, 64),
    ttlSeconds: ttlSeconds(kind),
  };
  // The tool NAME only (never pendingToolDetail: a command line can hold secrets).
  if ((kind === 'approval' || kind === 'input') && session.pendingTool) {
    const tool = cleanText(session.pendingTool, TOOL_MAX).replace(/[^A-Za-z0-9_.:-]/g, '');
    if (tool) message.toolName = tool;
  }
  return message;
}

export function createPushNotifier(deps: PushNotifierDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const lastSeen = new Map<string, PushView>();
  const pending = new Map<string, unknown>();
  const lastSent = new Map<string, number>();

  function fire(sessionId: string, kind: PushKind): void {
    const key = `${sessionId}:${kind}`;
    pending.delete(key);
    const live = deps.getSession(sessionId);
    if (!live) return;
    if (!stillApplies(kind, viewOf(live))) return;
    if (live.muted) return;
    if (!deps.canNotify(live)) return;
    const sentAt = lastSent.get(key);
    if (sentAt !== undefined && now() - sentAt < cooldownMs(kind)) return;
    const sink = deps.sink();
    if (!sink) return;
    const message = buildPushMessage(kind, live, randomUUID());
    if (!message) return;
    lastSent.set(key, now());
    sink.notify(message).catch((err: unknown) => {
      // Never the title or session content in a log line.
      deps.onError?.(`push ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  return {
    /** Feed every broadcast; only session_update messages with a session matter. */
    onBroadcast(data: { type: string; session?: unknown }): void {
      if (data.type !== 'session_update' || !data.session) return;
      const session = data.session as Session;
      if (!session.sessionId) return;
      const prev = lastSeen.get(session.sessionId);
      const next = viewOf(session);
      lastSeen.set(session.sessionId, next);
      if (session.status === 'ended') {
        lastSeen.delete(session.sessionId);
        return;
      }
      const kind = decidePush(prev, next);
      if (!kind) return;
      const key = `${session.sessionId}:${kind}`;
      if (pending.has(key)) return; // one pending notification per session and kind
      const delay = settleMs(kind, next);
      if (delay === 0) {
        fire(session.sessionId, kind);
        return;
      }
      pending.set(key, setTimer(() => fire(session.sessionId, kind), delay));
    },

    pendingCount(): number {
      return pending.size;
    },

    dispose(): void {
      for (const handle of pending.values()) clearTimer(handle);
      pending.clear();
      lastSeen.clear();
    },
  };
}

export type PushNotifier = ReturnType<typeof createPushNotifier>;
