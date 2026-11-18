// closeSuggestions.ts — which sessions are worth closing (Nov 17 2026, by request).
//
// The header's memory chip opens a "Sessions to close" list. This module answers it: the sessions that
// have been quiet for N minutes, each as `idle` (it ran prompts, then went quiet) or `unused` (it was
// never given a prompt). Quiet is measured from the person's last prompt, or the start when there is
// none (Nov 18 2026). Hooks and terminal output were the clock before, and they never stop: a TUI
// repaint or a Stop hook made every session look "used within 1 day".
//
// It only suggests. Closing is the person's choice and goes through the ordinary
// kill route; nothing here closes, sleeps or changes a session.
//
//   GET /api/session-close-suggestions?quietMinutes=60 → { ok, at, quietMinutes, suggestions }
//
// This Mac only (404 elsewhere), like /api/session-memory. A session is never listed while closing it
// could cost work: see `closeRefusal`. Unlike idle sleep (sessionSleep.ts) a session that `--resume`
// could not bring back (a remote host, another launch word, a fork or clone) may be listed, because
// here a person decides, row by row.
//
// The dialog asks twice: once to draw the list and again at the Close click, and it closes only what
// both answers hold. So the rule must stay cheap and free of side effects.

import { Router } from 'express';
import type { Request, Response } from 'express';
import { isLocalRequest } from './requestLocality.js';
import {
  DEFAULT_CLOSE_QUIET_MINUTES,
  CLOSE_QUIET_CHOICES,
  isCloseQuietChoice,
  type CloseSuggestion,
  type CloseSuggestionsResponse,
} from '../src/lib/closeSuggestions.js';
import type { Session } from '../src/types/session.js';

const MS_PER_MINUTE = 60_000;

export interface CloseContext {
  now: number;
  quietMinutes: number;
  /** Does the session's shared queue hold an item that is switched on (a prompt, loop or schedule)? */
  hasArmedQueue: (sessionId: string) => boolean;
}

export type CloseSession = Pick<
  Session,
  'sessionId' | 'status' | 'terminalId' | 'pinned' | 'central' | 'handsOff' | 'backgroundTaskCount'
  | 'pendingRequest' | 'startedAt' | 'lastActivityAt' | 'asleepAt' | 'isFloating' | 'teamRole' | 'isSubagent'
  | 'isExternal' | 'promptHistory'
>;

/**
 * The last time the person used it: their newest prompt (typed in the terminal, sent from the composer
 * or the queue), else the start. Hooks and terminal output don't count: they move with nobody there.
 */
function lastUsedAt(s: CloseSession): number {
  const lastPrompt = (s.promptHistory ?? []).reduce((latest, p) => Math.max(latest, p?.timestamp ?? 0), 0);
  return Math.max(lastPrompt, s.startedAt ?? 0);
}

/** Why `s` is not suggested now, or null when it is. First match wins; the queue is read last. */
export function closeRefusal(s: CloseSession, ctx: CloseContext): string | null {
  // An ended or sleeping card holds no process, so there is nothing to close.
  if (s.status === 'ended' || s.asleepAt) return 'ended';
  if (s.status !== 'idle' && s.status !== 'waiting') return 'busy';
  // A CLI in the person's own terminal app (or a card with no dashboard terminal) prints nowhere we can
  // see: typing at its prompt fires no hook, so "quiet" there cannot be told from "in use".
  if (s.isExternal || !s.terminalId) return 'no-terminal';
  if (s.pinned) return 'pinned';
  if (s.central) return 'central';
  if (s.handsOff) return 'hands-off';
  if (s.isFloating) return 'floating';
  // A teammate sits idle between tasks while its leader works.
  if (s.teamRole === 'member' || s.isSubagent) return 'team-member';
  if ((s.backgroundTaskCount ?? 0) > 0) return 'background-shells';
  if (s.pendingRequest) return 'asking';
  if (ctx.now - lastUsedAt(s) < ctx.quietMinutes * MS_PER_MINUTE) return 'recent';
  if (ctx.hasArmedQueue(s.sessionId)) return 'queue-armed';
  return null;
}

/** The sessions worth closing, in the order given. */
export function listCloseSuggestions(sessions: readonly CloseSession[], ctx: CloseContext): CloseSuggestion[] {
  return sessions
    .filter((s) => closeRefusal(s, ctx) === null)
    .map((s) => ({
      sessionId: s.sessionId,
      reason: (s.promptHistory?.length ?? 0) === 0 ? 'unused' as const : 'idle' as const,
      quietMs: ctx.now - lastUsedAt(s),
    }));
}

// ---- the route ----

export interface CloseSuggestionsDeps {
  sessions: () => CloseSession[];
  hasArmedQueue: CloseContext['hasArmedQueue'];
  now?: () => number;
  isLocal?: (req: Request) => boolean;
}

/** `?quietMinutes=`: absent is the default; anything else must be a whole number from the choices. */
function readQuietMinutes(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_CLOSE_QUIET_MINUTES;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const minutes = Number(raw);
  return isCloseQuietChoice(minutes) ? minutes : null;
}

export function createCloseSuggestionsRouter(deps: CloseSuggestionsDeps): Router {
  const isLocal = deps.isLocal ?? ((req: Request) => isLocalRequest(req));
  const router = Router();
  router.get('/session-close-suggestions', (req: Request, res: Response) => {
    if (!isLocal(req)) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    const quietMinutes = readQuietMinutes(req.query.quietMinutes);
    if (quietMinutes === null) {
      res.status(400).json({ ok: false, error: `quietMinutes must be one of ${CLOSE_QUIET_CHOICES.join(', ')}` });
      return;
    }
    const now = (deps.now ?? Date.now)();
    const body: CloseSuggestionsResponse = {
      ok: true,
      at: now,
      quietMinutes,
      suggestions: listCloseSuggestions(deps.sessions(), {
        now,
        quietMinutes,
        hasArmedQueue: deps.hasArmedQueue,
      }),
    };
    res.json(body);
  });
  return router;
}
