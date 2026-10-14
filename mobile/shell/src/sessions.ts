// sessions.ts — the Mac's session list as the shell sees it (AASC-19, AASC-21).
//
// GET /api/sessions answers a record keyed by session id. A paired phone gets
// only the sessions shared with remote devices (server/sessionVisibility.ts), so
// anything listed here is something the phone may open. The answer is untrusted
// input: unknown fields are dropped and an id must have the shape the backend's
// sessionRef and the Mac's `?session=` deep link accept.
import { bearer, type HttpRequester } from './http.js';
import { cleanLabel } from './text.js';

/** = the backend's PushNotifySchema.sessionRef and src/lib/deepLink.ts SESSION_ID. */
export const SESSION_REF = /^[A-Za-z0-9_-]{1,64}$/;
export const SESSION_TITLE_MAX = 80;
/** More than any Mac runs (MAX_SESSIONS is 50); bounds the work on a hostile answer. */
const MAX_LISTED = 500;

export type SessionStatus =
  | 'connecting' | 'idle' | 'prompting' | 'working' | 'approval' | 'input' | 'waiting' | 'ended';

const STATUSES: ReadonlySet<string> = new Set<SessionStatus>([
  'connecting', 'idle', 'prompting', 'working', 'approval', 'input', 'waiting', 'ended',
]);

export interface SessionLite {
  sessionId: string;
  status: SessionStatus;
  /** As src/lib/sessionDisplayTitle.ts: the title, else the project, else "Unnamed"; cleaned and capped. */
  title: string;
  lastActivityAt: number;
  startedAt: number;
  /** Per-session mute (server-backed): no push, no haptic, not counted by the widget. */
  muted: boolean;
  /** A transient failure banner (529, rate limit, network) is showing. */
  hasInterruption: boolean;
}

function time(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function toLite(raw: unknown): SessionLite | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.sessionId !== 'string' || !SESSION_REF.test(s.sessionId)) return null;
  if (typeof s.status !== 'string' || !STATUSES.has(s.status)) return null;
  return {
    sessionId: s.sessionId,
    status: s.status as SessionStatus,
    title: cleanLabel(s.title, SESSION_TITLE_MAX) || cleanLabel(s.projectName, SESSION_TITLE_MAX) || 'Unnamed',
    lastActivityAt: time(s.lastActivityAt),
    startedAt: time(s.startedAt),
    muted: s.muted === true,
    hasInterruption: Boolean(s.interruption),
  };
}

/** Sessions from GET /api/sessions (a record) or a WebSocket snapshot (an array). */
export function parseSessions(data: unknown): SessionLite[] {
  if (!data || typeof data !== 'object') return [];
  const values = Array.isArray(data) ? data : Object.values(data as Record<string, unknown>);
  const out: SessionLite[] = [];
  const seen = new Set<string>();
  for (const raw of values.slice(0, MAX_LISTED)) {
    const lite = toLite(raw);
    if (!lite || seen.has(lite.sessionId)) continue;
    seen.add(lite.sessionId);
    out.push(lite);
  }
  return out;
}

export type SessionsResult =
  | { status: 'ok'; sessions: SessionLite[] }
  | { status: 'signed-out' }
  | { status: 'offline' }
  | { status: 'error'; message: string };

/** The phone's view of a Mac's sessions, with a session token from /api/mobile/session. */
export async function listSessions(http: HttpRequester, origin: string, sessionToken: string): Promise<SessionsResult> {
  let res;
  try {
    res = await http.request({ method: 'GET', url: `${origin}/api/sessions`, headers: bearer(sessionToken) });
  } catch {
    return { status: 'offline' };
  }
  if (res.status === 200) return { status: 'ok', sessions: parseSessions(res.data) };
  if (res.status === 401) return { status: 'signed-out' };
  return { status: 'error', message: `Couldn't list the sessions (${res.status})` };
}
