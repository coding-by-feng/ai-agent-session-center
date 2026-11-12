/**
 * `aasc watch` (plan §9.9): one WebSocket per server, its snapshot, then session updates.
 * Each status change prints one line; moving into approval or input rings the bell and,
 * with --notify, raises a terminal notification (OSC 9, or OSC 777 on VTE terminals).
 */
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import { parseSessions, type RemoteSession } from './sessions.js';
import { cleanCell, clock, needsYou } from './render.js';

export interface WatchEvent {
  at: number;
  server: string;
  sessionId: string;
  title: string;
  from: string | null;
  to: string;
  attention: boolean;
}

/** Last known status per server, per session. */
export type WatchState = Map<string, Map<string, string>>;

export function createWatchState(): WatchState {
  return new Map();
}

function single(data: unknown): RemoteSession | null {
  try {
    return parseSessions({ one: data })[0] ?? null;
  } catch {
    return null;
  }
}

/** Fold one server message into the state; returns the status changes to print. */
export function applyWatchMessage(state: WatchState, server: string, msg: unknown, now: number): WatchEvent[] {
  if (!msg || typeof msg !== 'object') return [];
  const m = msg as Record<string, unknown>;
  if (m.type === 'snapshot') {
    let sessions: RemoteSession[] = [];
    try { sessions = parseSessions(m.sessions ?? {}); } catch { sessions = []; }
    state.set(server, new Map(sessions.map((s) => [s.sessionId, s.status])));
    return [];
  }
  const known = state.get(server) ?? new Map<string, string>();
  if (!state.has(server)) state.set(server, known);
  if (m.type === 'session_removed' && typeof m.sessionId === 'string') {
    known.delete(m.sessionId);
    return [];
  }
  if (m.type !== 'session_update') return [];
  const s = single(m.session);
  if (!s) return [];
  const from = known.get(s.sessionId) ?? null;
  known.set(s.sessionId, s.status);
  if (from === s.status) return [];
  return [{
    at: now,
    server,
    sessionId: s.sessionId,
    title: cleanCell(sessionDisplayTitle(s)),
    from,
    to: s.status,
    attention: needsYou(s.status),
  }];
}

export function formatWatchLine(ev: WatchEvent): string {
  const change = ev.from ? `${cleanCell(ev.from)} → ${cleanCell(ev.to)}` : `→ ${cleanCell(ev.to)}`;
  return `${clock(ev.at)}  ${ev.server}  ${ev.title}  ${change}${ev.attention ? '   ← needs you' : ''}`;
}

/** A desktop notification through the terminal: OSC 777 where VTE reads it, OSC 9 elsewhere (iTerm2, WezTerm, kitty, Windows Terminal). */
export function notifySequence(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const clean = cleanCell(text).replace(/;/g, ',').slice(0, 200);
  return env.VTE_VERSION ? `\x1b]777;notify;aasc;${clean}\x07` : `\x1b]9;${clean}\x07`;
}
