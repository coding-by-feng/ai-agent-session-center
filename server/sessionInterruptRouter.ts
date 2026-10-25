// sessionInterruptRouter.ts — the route a central's session_interrupt calls (MCP P5, Ruling P5-7):
//
//   POST /api/sessions/:id/interrupt  { confirm: true }  presses Esc in the session's terminal through the server
//                                                        prompt submitter, and waits (at most 10 s) for the turn to stop
//
// The submitter's `interrupt` presses Esc only while the session runs in that terminal, mid-turn or at a dialog (which
// the Esc declines), with its agent in front; it types nothing else, and answers whether it pressed. `key_send` refuses
// esc mid-turn (Ruling P3-11) and there is no ctrl-c, so this is the one way a central stops a turn.
//
// The route refuses, in this order:
//   403 a remote caller · 400 a body other than `{ confirm: true }` (a body-less POST included: a JSON body forces a
//   preflight, as kill and restart ask) · 404 no card, or no terminal · 409 not_started (a central's call, and AASC has
//   not heard the terminal's CLI or the card carries the never-started marker: it may be showing its trust question,
//   Ruling P4-58; nothing is typed into it).
// Then, for a central (`mcp:`), the Esc is noted in the central Esc book just before the submitter writes it (its
// `beforeEsc`; escHold.ts, Ruling 47), so the cancel stamp it causes is not taken for the person's Esc hold. No Esc
// written (the turn ended first), no note: a person's Esc soon after is still their hold. It answers 200
// { ok: true, pressed }.
//
// Every dependency is injected (`SessionInterruptDeps`): the module imports no store, PTY or submitter, so the tests and
// the live harness mount it with fakes. apiRouter.ts mounts it with the real ones.

import { Router, type Request, type Response } from 'express';
import log from './logger.js';

/** What the route reads of a session. */
export interface SessionInterruptSession {
  sessionId: string;
  terminalId?: string | null;
  /** `false`: the connecting timeout turned it idle before its terminal sent a hook. */
  startHeard?: boolean;
}

export interface SessionInterruptDeps {
  /** Did the request come from this Mac (requestLocality `isLocalRequest`)? */
  isLocal(req: Request): boolean;
  /** A session by any id it has gone by, or null. */
  getSession(id: string): SessionInterruptSession | null | undefined;
  /** Has AASC heard a hook from the CLI in this terminal (heardTerminals.ts)? */
  terminalHeard(terminalId: string): boolean;
  /** Is the caller a central (its client id starts with `mcp:`)? */
  isCentral(req: Request): boolean;
  /** The server submitter's Esc (promptSubmit.ts `interrupt`): runs `beforeEsc` just before it writes one; true when it pressed. */
  interrupt(target: { sessionId: string; terminalId: string; beforeEsc?: () => void }): Promise<boolean>;
  /** A central is about to press Esc in this session (escHold.ts `centralEscBook.note`). */
  noteCentralEsc(sessionId: string, terminalId: string): void;
}

/** Express 5 may give a param as an array; the route uses a single value. */
const param = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : '');

/** Is the body exactly what the route asks for, `{ confirm: true }`? */
const confirmed = (body: unknown): boolean =>
  typeof body === 'object' && body !== null && !Array.isArray(body) && (body as { confirm?: unknown }).confirm === true;

export function createSessionInterruptRouter(deps: SessionInterruptDeps): Router {
  const router = Router();

  router.post('/sessions/:id/interrupt', async (req: Request, res: Response) => {
    if (!deps.isLocal(req)) {
      res.status(403).json({ ok: false, error: 'This Mac only' });
      return;
    }
    if (!confirmed(req.body)) {
      res.status(400).json({ ok: false, error: 'An interrupt needs { "confirm": true }' });
      return;
    }
    const session = deps.getSession(param(req.params.id));
    const terminalId = session?.terminalId;
    if (!session || typeof terminalId !== 'string' || terminalId === '') {
      res.status(404).json({ ok: false, error: 'Session not found' });
      return;
    }
    const central = deps.isCentral(req);
    if (central && (session.startHeard === false || !deps.terminalHeard(terminalId))) {
      res.status(409).json({ ok: false, error: 'not_started' });
      return;
    }
    const target = {
      sessionId: session.sessionId,
      terminalId,
      ...(central ? { beforeEsc: () => deps.noteCentralEsc(session.sessionId, terminalId) } : {}),
    };
    try {
      const pressed = await deps.interrupt(target);
      if (pressed) log.info('api', `Interrupted the turn in terminal ${terminalId.slice(0, 12)}${central ? ' for a central' : ''}`);
      res.json({ ok: true, pressed });
    } catch (err: unknown) {
      log.error('api', `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ ok: false, error: 'Failed to interrupt the session' });
    }
  });

  return router;
}
