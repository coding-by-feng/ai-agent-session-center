// requestAnswer.ts — answer a waiting request from a card (AASC-43).
//
// POST /api/sessions/:id/requests/:requestId/answer  { choice, optionIndex? }
//
// The phone sends an intent, never bytes: "answer request R with choice C". The Mac
// answers only if the session is visible to the caller, still waits on R (a card the
// desktop already answered gets 409 stale instead of a stray keystroke), and the caller
// may drive it under the control baton. Then it types the keys its own map gives
// (answerKeys/) through the terminals' write path, clears the request and tells every
// device. The hooks that follow move the session on.
//
// Answering through the PermissionRequest hook's own decision output was rejected:
// the hook would have to block until a phone answers (plan 11 §3.3).

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { answerKeysFor } from './answerKeys/index.js';
import log from './logger.js';
import type { ControlHolderView } from './presenceManager.js';
import type { Session } from '../src/types/session.js';

/** Answers one device may send a minute: a person tapping cards sends a few. */
export const ANSWERS_PER_MINUTE = 30;

const BUDGET_WINDOW_MS = 60_000;

export interface RequestAnswerDeps {
  /** apiRouter's /sessions/:id gate: 404 for a session the caller may not see. */
  requireVisibleSession: RequestHandler;
  getSession(sessionId: string): Session | null;
  /** The device a request speaks for, '' when unidentified (apiRouter's clientIdFromRequest). */
  clientIdOf(req: Request): string;
  isLocal(req: Request): boolean;
  canControl(sessionId: string, clientId: string): boolean;
  /** Refresh the caller's baton, taking it when free (presenceManager). */
  noteControlActivity(sessionId: string, clientId: string): boolean;
  getController(sessionId: string): ControlHolderView | null;
  terminalExists(terminalId: string): boolean;
  /** The PTY write path POST /terminals/:id/write uses. */
  writeToTerminal(terminalId: string, data: string): void;
  clearPendingRequest(sessionId: string, requestId: string): Session | null;
  broadcastSession(session: Session): void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

const AnswerSchema = z
  .object({
    choice: z.enum(['allow_once', 'allow_always', 'deny', 'option']),
    optionIndex: z.number().int().min(0).max(99).optional(),
  })
  .strict()
  .refine((body) => body.choice !== 'option' || body.optionIndex !== undefined, { message: 'optionIndex is required' });

function str(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value != null ? String(value) : '';
}

function refuse(res: Response, status: number, code: string, error: string, extra: Record<string, unknown> = {}): void {
  res.status(status).json({ success: false, error, code, ...extra });
}

export function createRequestAnswerRouter(deps: RequestAnswerDeps): Router {
  const router = Router();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const budgets = new Map<string, { windowStart: number; count: number }>();

  /** Count one more answer in this device's minute; the seconds to wait when it goes over, else 0. */
  function overBudget(device: string): number {
    const t = now();
    const bucket = budgets.get(device);
    if (!bucket || t - bucket.windowStart >= BUDGET_WINDOW_MS) {
      budgets.set(device, { windowStart: t, count: 1 });
      return 0;
    }
    budgets.set(device, { ...bucket, count: bucket.count + 1 });
    if (bucket.count + 1 <= ANSWERS_PER_MINUTE) return 0;
    return Math.max(1, Math.ceil((bucket.windowStart + BUDGET_WINDOW_MS - t) / 1000));
  }

  router.post('/sessions/:id/requests/:requestId/answer', deps.requireVisibleSession, (req: Request, res: Response) => {
    const parsed = AnswerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid answer' });
      return;
    }
    const answer = parsed.data;
    const session = deps.getSession(str(req.params.id));
    if (!session) {
      res.status(404).json({ success: false, error: 'Session not found' });
      return;
    }
    const sessionId = session.sessionId;
    const requestId = str(req.params.requestId);
    const local = deps.isLocal(req);
    const clientId = deps.clientIdOf(req);
    const device = clientId || (local ? 'local' : `remote:${req.ip ?? ''}`);

    const retryAfter = overBudget(device);
    if (retryAfter > 0) {
      refuse(res, 429, 'rate_limited', 'Too many answers from this device; wait a moment', { retryAfter });
      return;
    }

    const pending = session.pendingRequest;
    if (!pending || pending.id !== requestId) {
      refuse(res, 409, 'stale', 'Already answered');
      return;
    }

    // The baton, as terminal_input on the live connection judges it: a remote caller
    // drives only with a device id and the baton (or a free one); an unidentified
    // caller on the Mac itself is not arbitrated.
    if ((!local && !clientId) || (clientId && !deps.canControl(sessionId, clientId))) {
      refuse(res, 423, 'control_held', 'Another device is driving this session', { driver: deps.getController(sessionId) });
      return;
    }

    const keys = answerKeysFor(pending, answer, env);
    if (keys === null) {
      refuse(res, 422, 'unknown_prompt', 'AASC can’t answer this prompt from here; open the terminal');
      return;
    }

    const terminalId = session.terminalId;
    if (!terminalId || !deps.terminalExists(terminalId)) {
      refuse(res, 409, 'no_terminal', 'The session has no live terminal');
      return;
    }

    if (clientId) deps.noteControlActivity(sessionId, clientId);
    deps.writeToTerminal(terminalId, keys);
    const updated = deps.clearPendingRequest(sessionId, requestId);
    if (updated) deps.broadcastSession(updated);
    const option = answer.optionIndex !== undefined ? ` option=${answer.optionIndex}` : '';
    log.info('answer', `session=${sessionId.slice(0, 8)} request=${requestId.slice(0, 64)} choice=${answer.choice}${option} device=${device.slice(0, 64)}`);
    res.status(202).json({ success: true, data: { accepted: true } });
  });

  return router;
}
