// phoneConfirmRoutes.ts — a paired phone answers a central's confirmation (Ruling P5-15, Ruling P5-20):
//
//   GET  /api/phone-confirms           the cards waiting that this phone may answer, and this Mac's time (`now`)
//   POST /api/phone-confirms/:cardId   its answer: { "decision": "allow" | "deny" }
//
// and the feed to remote devices: `mcp_phone_confirm` (a card to show) and `mcp_phone_confirm_resolved` (it was
// answered, expired or withdrawn), sent through `broadcastByLocality(null, message)`: this Mac's own windows have
// their own feed (confirmRoutes.ts), so they get nothing here.
//
// A phone answers only what it could already do itself (PHONE_ANSWERABLE: each tool, and the phone-profile route it
// mirrors), and only about sessions shared with it: the central's card is shared (`remoteVisible`), and so is the
// card's target when it has one (a note's session is its target). `phoneMayAnswer` (phoneAnswerable.ts, the one rule
// the gate and the push read too) decides it, and is asked again at answer time, so a session unshared after its card
// opened is answered 404; the feed asks it again after each session broadcast and every PHONE_FEED_RESYNC_MS, so that
// card also leaves the phones (and one shared later reaches them).
// Mac-only: `session_set_shared`, `resource_uninstall`, `history_delete`, `agenda_delete` and everything else.
//
// Who may ask, in this order:
//   1. a central's own call (`x-aasc-client-id: mcp:…`) is 403, before its body is read: a central never answers a
//      confirmation, its own or another's, by any path;
//   2. with central sessions off (`mcp.enabled: false`), 404;
//   3. anyone who is not a paired phone (`phoneOf(req) === null`), the Mac included, 404: the Mac answers through
//      /api/mcp/confirm, which stays Mac-only (ruling C-M6);
// then a card that is unknown, expired, or not answerable by a phone now is 404, and one already answered is 409.
//
// A phone never sees a confirmId, a fingerprint or the call's arguments: each view is `confirmView`, built field by
// field from the record. Mounted in the /api chain behind authMiddleware and the phone profile, which lets these two
// paths through and nothing under /mcp.
//
// `startServerPhoneConfirms` is the server's wiring (server/index.ts): the routes, the feed and the push
// (confirmPush.ts) over the server's book, with the store's sessions and the remote-visibility rule handed in.

import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  MCP_PHONE_CONFIRM,
  MCP_PHONE_CONFIRM_RESOLVED,
  type McpPhoneConfirmMessage,
  type McpPhoneConfirmResolvedMessage,
} from '../../src/types/mcpPhoneConfirm.js';
import type { Session } from '../../src/types/session.js';
import { WS_TYPES } from '../constants.js';
import log from '../logger.js';
import type { PushSink } from '../push/pushNotifier.js';
import { canSeeSession } from '../sessionVisibility.js';
import { resolveCentralSession } from './centrals.js';
import { CONFIRM_KEEP_MS, CONFIRM_TTL_MS, confirms, type ConfirmBook, type PendingConfirm } from './confirm.js';
import { startConfirmPush } from './confirmPush.js';
import { confirmView } from './confirmRoutes.js';
import type { BroadcastSubscribe } from './events.js';
import { PHONE_ANSWERABLE, phoneMayAnswer, shareable, type PhoneAnswerDeps } from './phoneAnswerable.js';
import { MCP_CLIENT_PREFIX } from './policy.js';
import { isMcpEnabled } from './runtime.js';

/** What the phone feed sends. */
export type PhoneConfirmFeedMessage = McpPhoneConfirmMessage | McpPhoneConfirmResolvedMessage;

export interface PhoneConfirmDeps extends PhoneAnswerDeps {
  /** The paired phone a request's session token belongs to, or null (a password sign-in, or the Mac). */
  phoneOf(req: Request): string | null;
  /** Is this one of a central's own calls (`mcp:`)? */
  isCentral(req: Request): boolean;
  /** `mcp.enabled` (runtime.ts `isMcpEnabled`). */
  enabled(): boolean;
  book: ConfirmBook;
}

/** The phone router, plus the way to stop its listener on the book. */
export type PhoneConfirmRouter = Router & { close(): void };

/** A card id is a UUID; anything much longer is none. */
const CARD_ID_MAX = 64;
const NOT_FOUND = { ok: false, error: 'Not found' } as const;
const BAD_BODY = 'The body must be JSON: { "decision": "allow" } or { "decision": "deny" }.';
const answerBody = z.object({ decision: z.enum(['allow', 'deny']) });
/** How much of a phone's device id an answer's log line keeps: enough to tell two phones apart, never a token. */
const DEVICE_LOG_CHARS = 8;

/** The first characters of a device id, letters and digits only, for a log line. */
function shortDevice(deviceId: string | null): string {
  return (deviceId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, DEVICE_LOG_CHARS) || 'unknown';
}

/** The client id a request names, as http.ts reads it: any request that names an `mcp:` id is a central's. */
export function isCentralRequest(req: Request): boolean {
  const raw = req.headers['x-aasc-client-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().toLowerCase().startsWith(MCP_CLIENT_PREFIX);
}

/** The phone's two routes. `close()` stops its listener on the book (it remembers answered cards for a 409). */
export function createPhoneConfirmRouter(deps: PhoneConfirmDeps): PhoneConfirmRouter {
  const { book } = deps;
  const router = Router();
  // Card id → its record once answered, kept as long as the book keeps it: a second answer is 409, not 404.
  let answered = new Map<string, PendingConfirm>();
  const forgetOld = (now: number): void => {
    answered = new Map([...answered].filter(([, r]) => now - r.createdAt <= CONFIRM_TTL_MS + CONFIRM_KEEP_MS));
  };
  const stop = book.onChange((e) => {
    if (e.kind !== 'resolved' || !PHONE_ANSWERABLE.has(e.confirm.tool)) return;
    forgetOld(Date.now());
    answered = new Map(answered).set(e.confirm.cardId, e.confirm);
  });

  const guard = (req: Request, res: Response, next: NextFunction): void => {
    if (deps.isCentral(req)) {
      res.status(403).json({ ok: false, error: 'A central cannot answer a confirmation.' });
      return;
    }
    if (!deps.enabled() || deps.phoneOf(req) === null) {
      res.status(404).json(NOT_FOUND);
      return;
    }
    next();
  };

  router.get('/phone-confirms', guard, (_req, res) => {
    // `now`, this Mac's clock: the phone counts each card's time left from it, not from its own clock.
    const confirms = book.pending().filter((r) => phoneMayAnswer(r, deps)).map(confirmView);
    res.json({ ok: true, now: Date.now(), confirms });
  });

  // Read here so a body that is not JSON gets the fixed answer; in the running server the app's parser has read it.
  const readJson = express.json({ limit: '1kb' });
  router.post(
    '/phone-confirms/:cardId',
    guard,
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
      const pending = cardId === '' || cardId.length > CARD_ID_MAX ? undefined : book.pending().find((r) => r.cardId === cardId);
      const record = pending ?? answered.get(cardId);
      // Unknown, expired, a Mac-only tool, or a session no longer shared: the phone learns nothing more.
      if (record === undefined || !shareable(record, deps)) {
        res.status(404).json(NOT_FOUND);
        return;
      }
      const result = book.answer(cardId, body.data.decision, 'phone');
      if (result === 'gone') {
        res.status(404).json(NOT_FOUND);
        return;
      }
      if (result === 'decided') {
        res.status(409).json({ ok: false, error: 'already-answered' });
        return;
      }
      log.info('mcp', `The person ${result.state} a central's ${result.tool} on a phone (device ${shortDevice(deps.phoneOf(req))})`);
      res.json({ ok: true, state: result.state });
    },
  );

  return Object.assign(router, { close: stop });
}

export interface PhoneFeedDeps extends PhoneAnswerDeps {
  /** wsManager's `broadcastByLocality`: always `null` for this Mac's windows, the message for remote devices. */
  broadcastByLocality(local: null, remote: PhoneConfirmFeedMessage): void;
  /** wsManager's `onBroadcast`: a session's update or removal re-asks the phone rule of every waiting card at once. */
  subscribe?: BroadcastSubscribe;
}

/**
 * How often the feed re-asks the phone rule of every waiting card, besides each session broadcast: un-sharing one
 * session (PUT /sessions/:id/remote-visible) sends no broadcast that `onBroadcast` sees, so this bounds how long an
 * unshared session's card stays on a phone.
 */
export const PHONE_FEED_RESYNC_MS = 2_000;

/** The broadcasts after which a card's sessions may have been shared, unshared or removed. */
const SESSION_CHANGES: ReadonlySet<string> = new Set([WS_TYPES.SESSION_UPDATE, WS_TYPES.SESSION_REMOVED, WS_TYPES.SNAPSHOT]);

/**
 * The feed to remote devices: each card a phone may answer when it opens, and the resolution of each card it sent
 * (and no other). The rule is asked again after each session broadcast and every PHONE_FEED_RESYNC_MS (AASC-27: an
 * unshare cuts every remote device at once): a sent card that no longer passes is withdrawn from the phones
 * (`mcp_phone_confirm_resolved`, as denied, the windows' word for a withdrawn card) and stays pending for the Mac;
 * a waiting card that passes now is sent. A failing send is logged, never thrown. Answers the way to stop it.
 */
export function startPhoneConfirmFeed(book: Pick<ConfirmBook, 'onChange' | 'pending'>, deps: PhoneFeedDeps): () => void {
  const sent = new Set<string>();
  const send = (message: PhoneConfirmFeedMessage, what: string): void => {
    try {
      deps.broadcastByLocality(null, message);
    } catch (err) {
      // A phone that misses one reads the list again when its socket reconnects.
      log.warn('mcp', `Could not send ${what} to the phones: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const sendCard = (r: PendingConfirm): void => {
    sent.add(r.cardId);
    send({ type: MCP_PHONE_CONFIRM, confirm: confirmView(r) }, 'a confirmation');
  };
  const resync = (): void => {
    try {
      for (const r of book.pending()) {
        const may = phoneMayAnswer(r, deps);
        if (may && !sent.has(r.cardId)) sendCard(r);
        if (!may && sent.delete(r.cardId)) {
          send({ type: MCP_PHONE_CONFIRM_RESOLVED, cardId: r.cardId, state: 'denied' }, 'a withdrawn confirmation');
        }
      }
    } catch (err) {
      log.warn('mcp', `Could not re-check the phones' confirmations: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const stopBook = book.onChange((e) => {
    const r = e.confirm;
    if (e.kind === 'opened') {
      if (phoneMayAnswer(r, deps)) sendCard(r);
      return;
    }
    if (r.state === 'pending' || !sent.delete(r.cardId)) return;
    send({ type: MCP_PHONE_CONFIRM_RESOLVED, cardId: r.cardId, state: r.state }, 'a confirmation’s answer');
  });
  const stopBroadcasts = deps.subscribe?.((m) => {
    if (SESSION_CHANGES.has(m.type)) resync();
  });
  const timer = setInterval(resync, PHONE_FEED_RESYNC_MS);
  timer.unref?.();
  return () => {
    stopBook();
    stopBroadcasts?.();
    clearInterval(timer);
  };
}

export interface ServerPhoneConfirmDeps {
  phoneOf(req: Request): string | null;
  getSession(id: string): Session | null | undefined;
  sessions(): readonly Session[];
  broadcastByLocality(local: null, remote: PhoneConfirmFeedMessage): void;
  /** wsManager's `onBroadcast`. */
  subscribe: BroadcastSubscribe;
  /** The push sink now (a test sink, else the cloud connection), or null. */
  sink(): PushSink | null;
  onError(message: string): void;
}

/** The server's phone confirmations: the router to mount, whose `close()` also stops the feed and the push. */
export function startServerPhoneConfirms(deps: ServerPhoneConfirmDeps): PhoneConfirmRouter {
  const answerDeps: PhoneAnswerDeps = {
    getSession: deps.getSession,
    centralCard: (centralId) => resolveCentralSession(centralId, deps.sessions()),
    isShared: (sessionId) => canSeeSession(false, deps.getSession(sessionId)),
  };
  const router = createPhoneConfirmRouter({
    ...answerDeps,
    phoneOf: deps.phoneOf,
    isCentral: isCentralRequest,
    enabled: isMcpEnabled,
    book: confirms,
  });
  const stopFeed = startPhoneConfirmFeed(confirms, {
    ...answerDeps,
    broadcastByLocality: deps.broadcastByLocality,
    subscribe: deps.subscribe,
  });
  const stopPush = startConfirmPush({
    book: confirms,
    mayPhoneAnswer: (r) => phoneMayAnswer(r, answerDeps),
    centralCard: answerDeps.centralCard,
    sink: deps.sink,
    onError: deps.onError,
  });
  const closeRouter = router.close;
  return Object.assign(router, {
    close(): void {
      closeRouter();
      stopFeed();
      stopPush();
    },
  });
}
