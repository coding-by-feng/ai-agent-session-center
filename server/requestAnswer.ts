// requestAnswer.ts — answer a waiting request from a card (AASC-43).
//
// POST /api/sessions/:id/requests/:requestId/answer  { choice, optionIndex? }
//
// The phone sends an intent, never bytes: "answer request R with choice C". The Mac
// answers only if the session is visible to the caller, still waits on R (a card the
// desktop already answered gets 409 stale instead of a stray keystroke), and the caller
// may drive it under the control baton. A terminal showing the agent at work means
// the dialog was answered on the Mac: stale too. An input cut to fit the card can be
// denied but never allowed. Then it types the keys its own map gives (answerKeys/)
// through the terminals' write path, clears the request and tells every device. The
// hooks that follow move the session on.
//
// Answering through the PermissionRequest hook's own decision output was rejected:
// the hook would have to block until a phone answers (plan 11 §3.3).

import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { answerKeysFor } from './answerKeys/index.js';
import { isAgentBusyOutput } from './approvalDetector.js';
import { extractToken, getTokenDeviceId, getTokenLineage } from './authManager.js';
import { SESSION_STATUS } from './constants.js';
import log from './logger.js';
import type { ControlHolderView } from './presenceManager.js';
import type { Session } from '../src/types/session.js';

/** Answers one device may send a minute: a person tapping cards sends a few. */
export const ANSWERS_PER_MINUTE = 30;

const BUDGET_WINDOW_MS = 60_000;
/** Past this many devices in the budget map, expired windows are swept. */
const BUDGET_SWEEP_SIZE = 256;

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
  /** The last of the terminal's output, to see whether the agent already moved on. */
  terminalOutputTail(terminalId: string): string | null;
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

/**
 * Who an answer counts against: the paired phone, else the sign-in, else this Mac. Not
 * the client id: one sign-in may bind any number of them (clientBinding.ts).
 */
function deviceOf(req: Request, local: boolean): string {
  if (local) return 'local';
  const token = extractToken(req);
  const phone = getTokenDeviceId(token);
  if (phone) return `phone:${phone}`;
  const lineage = getTokenLineage(token);
  return lineage ? `signin:${lineage}` : `remote:${req.ip ?? ''}`;
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
    if (budgets.size > BUDGET_SWEEP_SIZE) {
      for (const [key, old] of budgets) if (t - old.windowStart >= BUDGET_WINDOW_MS) budgets.delete(key);
    }
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
    const device = deviceOf(req, local);

    const retryAfter = overBudget(device);
    if (retryAfter > 0) {
      refuse(res, 429, 'rate_limited', 'Too many answers from this device; wait a moment', { retryAfter });
      return;
    }

    const pending = session.pendingRequest;
    const gone = session.status === SESSION_STATUS.ENDED || session.status === SESSION_STATUS.CONNECTING;
    if (!pending || pending.id !== requestId || gone) {
      refuse(res, 409, 'stale', 'Already answered');
      return;
    }

    // A dialog answered at the Mac leaves the request until the call's PostToolUse,
    // which a long command delays for its whole run. The spinner says the agent is past
    // the dialog (it never shows at one): drop the request for every device.
    const terminalId = session.terminalId;
    const live = !!terminalId && deps.terminalExists(terminalId);
    if (live && isAgentBusyOutput(deps.terminalOutputTail(terminalId))) {
      const updated = deps.clearPendingRequest(sessionId, requestId);
      if (updated) deps.broadcastSession(updated);
      refuse(res, 409, 'stale', 'Already answered');
      return;
    }

    // The baton, as terminal_input on the live connection judges it: a remote caller
    // drives only with a device id and the baton (or a free one); an unidentified
    // caller on the Mac itself is not arbitrated.
    if ((!local && !clientId) || (clientId && !deps.canControl(sessionId, clientId))) {
      // The card names the driver; another device's client id stays on the Mac.
      const holder = deps.getController(sessionId);
      refuse(res, 423, 'control_held', 'Another device is driving this session', {
        driver: holder ? { label: holder.label, online: holder.online } : null,
      });
      return;
    }

    const keys = answerKeysFor(pending, answer, env);
    if (keys === null) {
      refuse(res, 422, 'unknown_prompt', 'AASC can’t answer this prompt from here; open the terminal');
      return;
    }
    if (pending.inputTruncated && (answer.choice === 'allow_once' || answer.choice === 'allow_always')) {
      refuse(res, 422, 'input_truncated', 'This request is too long to show in full; open the terminal to allow it');
      return;
    }

    if (!live || !terminalId) {
      refuse(res, 409, 'no_terminal', 'The session has no live terminal');
      return;
    }

    if (clientId) deps.noteControlActivity(sessionId, clientId);
    deps.writeToTerminal(terminalId, keys);
    const updated = deps.clearPendingRequest(sessionId, requestId);
    if (updated) deps.broadcastSession(updated);
    const option = answer.optionIndex !== undefined ? ` option=${answer.optionIndex}` : '';
    log.info('answer', `session=${sessionId.slice(0, 8)} request=${requestId.slice(0, 64)} choice=${answer.choice}${option} device=${device.slice(0, 15)} client=${clientId.slice(0, 12) || '-'}`);
    res.status(202).json({ success: true, data: { accepted: true } });
  });

  return router;
}
