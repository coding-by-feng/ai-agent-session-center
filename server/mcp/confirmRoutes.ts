// confirmRoutes.ts — the person's side of a confirmation (confirm.ts), mounted by http.ts's router:
//
//   GET  /api/mcp/confirms           the cards waiting for the person (a window that opened late)
//   POST /api/mcp/confirm/:cardId    the person's answer: { "decision": "allow" | "deny" }
//
// and the two feeds to this Mac's windows: `mcp_confirm` (a card to show) and `mcp_confirm_resolved` (it was
// answered, expired or withdrawn).
//
// A card is known by its cardId only. A view is built field by field (`confirmView`), never by spreading a record:
// the record holds the central's confirmId and the call's arguments, which never leave the server this way, so a
// central cannot answer its own confirmation by the id it holds, nor read what another central asked. Behind http.ts's
// gate (404 to anyone but this Mac, and with central sessions switched off), every route refuses a central's own call
// (`mcp:`) with 403, before a body is read. Each feed goes through http.ts's `send` (`broadcastByLocality(msg, null)`).

import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import {
  MCP_CONFIRM,
  MCP_CONFIRM_RESOLVED,
  type McpConfirmMessage,
  type McpConfirmResolvedMessage,
  type McpConfirmView,
} from '../../src/types/mcpConfirm.js';
import log from '../logger.js';
import { scrubText } from './activity.js';
import { CONFIRM_DETAIL_MAX, CONFIRM_SUMMARY_MAX, type ConfirmBook, type PendingConfirm } from './confirm.js';

/** What the confirm feeds send. */
export type ConfirmFeedMessage = McpConfirmMessage | McpConfirmResolvedMessage;

export interface ConfirmRouteDeps {
  confirms: ConfirmBook;
  /** http.ts's gate: 404 to a caller that is not this Mac, or with central sessions switched off. */
  gate: RequestHandler;
  /** http.ts's refusal of a central's own call (`mcp:`), with a fixed phrase. */
  notForCentral(what: string): RequestHandler;
  /** http.ts's one way to this Mac's windows: never throws. */
  send(build: () => ConfirmFeedMessage, what: string): void;
}

/** A card id is a UUID; anything much longer is none. */
const CARD_ID_MAX = 64;
const BAD_BODY = 'The body must be JSON: { "decision": "allow" } or { "decision": "deny" }.';
const answerBody = z.object({ decision: z.enum(['allow', 'deny']) });

/**
 * A confirmation as this Mac's windows see it: its public fields, built one by one, its words scrubbed again (a
 * second lock on the way out). Never its confirmId, never its arguments.
 */
export function confirmView(r: PendingConfirm): McpConfirmView {
  return {
    cardId: r.cardId,
    centralId: r.centralId,
    tool: scrubText(String(r.tool), 64),
    risk: r.risk,
    summary: scrubText(String(r.summary), CONFIRM_SUMMARY_MAX),
    detail: r.detail === null ? null : String(r.detail).slice(0, CONFIRM_DETAIL_MAX),
    targetSessionId: r.targetSessionId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

/** Mounts the two routes on `router` and starts the feeds; answers the way to stop them. */
export function mountConfirmRoutes(router: Router, deps: ConfirmRouteDeps): () => void {
  const { confirms, gate, notForCentral, send } = deps;

  router.get('/mcp/confirms', gate, notForCentral('read the confirmations'), (_req, res) => {
    res.json({ ok: true, confirms: confirms.pending().map(confirmView) });
  });

  // Read here so a body that is not JSON gets the fixed answer; in the running server the app's parser has read it.
  const readJson = express.json({ limit: '1kb' });
  router.post(
    '/mcp/confirm/:cardId',
    gate,
    // A central never answers a confirmation, its own or another's: refused before the body is read.
    notForCentral('answer a confirmation'),
    (req: Request, res: Response, next: NextFunction) => {
      readJson(req, res, (err?: unknown) => {
        if (err !== undefined) {
          res.status(400).json({ ok: false, error: BAD_BODY });
          return;
        }
        next();
      });
    },
    (req: Request, res: Response) => {
      const body = answerBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ ok: false, error: BAD_BODY });
        return;
      }
      const cardId = String(req.params.cardId ?? '');
      const answered = cardId === '' || cardId.length > CARD_ID_MAX ? 'gone' : confirms.answer(cardId, body.data.decision);
      if (answered === 'gone') {
        res.status(404).json({ ok: false, error: 'Confirmation not found' });
        return;
      }
      if (answered === 'decided') {
        res.status(409).json({ ok: false, error: 'already-answered' });
        return;
      }
      log.info('mcp', `The person ${answered.state} a central's ${answered.tool} on the Mac`);
      res.json({ ok: true, state: answered.state });
    },
  );

  return confirms.onChange((e) => {
    if (e.kind === 'opened') {
      send(() => ({ type: MCP_CONFIRM, confirm: confirmView(e.confirm) }), 'a confirmation');
      return;
    }
    const { state } = e.confirm;
    if (state === 'pending') return;
    send(() => ({ type: MCP_CONFIRM_RESOLVED, cardId: e.confirm.cardId, state }), 'a confirmation’s answer');
  });
}
