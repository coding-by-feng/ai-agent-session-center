// gate.ts — who may call /mcp: the Mac itself, naming itself, carrying the token of a live central.
//
// A request gets through only when all four of these hold. They are checked in this order, so when
// a request breaks several the first one names the refusal:
//
//   1. the connection is the Mac: a loopback peer, no proxy header, not on the remote-only
//      listener                                                   -> 403 NOT_LOCAL
//   2. Host names this machine (a DNS-rebinding page names its own domain)
//                                                                  -> 403 BAD_HOST
//   3. Origin is absent or names this machine, and the browser does not mark the request
//      cross-site (a page on another site sends its own Origin)    -> 403 BAD_ORIGIN
//   4. `Authorization: Bearer <token>` is the token of a live central
//                                                                  -> 401 NO_TOKEN / BAD_TOKEN
//
// Steps 1-3 are `isLocalRequest` (requestLocality.ts), AASC's one answer to "is this the Mac
// itself?". The gate has no locality rule of its own: `isLocalRequest` decides, and whatever it
// refuses stays refused. What the gate adds is the name of the rule that was broken, so a caller
// (and a log) can tell a LAN client from a rebinding page. Step 4 comes last, so a caller that is
// not the Mac never reaches the token compare. The token says WHICH central is calling; it is not
// the wall.
//
// No Origin is fine. Claude Code and Codex are CLIs, not browsers: Claude Code 2.1.309 sends the
// bearer header and no Origin.
//
// The gate only reads. It keeps no state and logs nothing, and a refusal's message is fixed text:
// never the token, the Authorization header, or anything else the caller chose to send.

import type { IncomingMessage } from 'node:http';
import { isLocalRequest, namesThisMachine, type LocalityRequest } from '../requestLocality.js';
import type { CentralRegistry } from './centrals.js';
import type { CentralRecord } from './types.js';

/**
 * The gate's answer: the live central that may call, or the refusal to send back. 403s mean the
 * request is not the Mac itself; 401s mean it is, but no live central stands behind its token.
 */
export type GateResult =
  | { ok: true; central: CentralRecord }
  | {
      ok: false;
      status: 401 | 403;
      code: 'NOT_LOCAL' | 'BAD_HOST' | 'BAD_ORIGIN' | 'NO_TOKEN' | 'BAD_TOKEN';
      message: string;
    };

type Refusal = Extract<GateResult, { ok: false }>;

/**
 * The status and the text of each refusal. The text is fixed on purpose: nothing the caller sent
 * is echoed back.
 */
const REFUSALS: Readonly<Record<Refusal['code'], Pick<Refusal, 'status' | 'message'>>> = {
  NOT_LOCAL: {
    status: 403,
    message: '/mcp only answers requests made directly from this machine.',
  },
  BAD_HOST: {
    status: 403,
    message: 'The Host header must name this machine: localhost, 127.0.0.1 or [::1].',
  },
  BAD_ORIGIN: {
    status: 403,
    message:
      '/mcp does not answer a page on another site (a foreign Origin, or a cross-site request).',
  },
  NO_TOKEN: {
    status: 401,
    message: '/mcp needs the token of a live central, sent as: Authorization: Bearer <token>',
  },
  BAD_TOKEN: {
    status: 401,
    message: 'No live central holds that token.',
  },
};

function refuse(code: Refusal['code']): Refusal {
  const { status, message } = REFUSALS[code];
  return { ok: false, status, code, message };
}

/**
 * A Host that names this machine. It stands in for the caller's own while the connection is
 * judged alone.
 */
const LOCAL_HOST = 'localhost';

/**
 * Is the CONNECTION the Mac: a loopback peer, no proxy header, not on the remote-only listener?
 * `isLocalRequest` answers that, but in the same yes/no it also judges what the request says about
 * itself (Host, Origin, Sec-Fetch-Site). Asking it about this connection with those three swapped
 * for a local page's leaves only the connection to judge, which is how a refusal can tell the
 * connection from the page. The request is copied, never changed.
 */
function connectionIsLocal(req: LocalityRequest): boolean {
  return isLocalRequest({
    ip: req.ip,
    socket: req.socket,
    headers: { ...req.headers, host: LOCAL_HOST, origin: undefined, 'sec-fetch-site': undefined },
  });
}

/**
 * `isLocalRequest` refused the request: name the first rule it broke, in the order connection,
 * Host, Origin.
 */
function refuseNonLocal(req: LocalityRequest): Refusal {
  if (!connectionIsLocal(req)) return refuse('NOT_LOCAL');
  if (!namesThisMachine({ host: req.headers?.host })) return refuse('BAD_HOST');
  // The connection and the Host are the Mac's, so all `isLocalRequest` can still be refusing is the
  // page's Origin or a Sec-Fetch-Site of cross-site: either way, a page on another site. A rule
  // added to `isLocalRequest` later is refused all the same; it would be named here until this
  // function learns it.
  return refuse('BAD_ORIGIN');
}

/**
 * What follows the `Bearer` scheme (any case) in an Authorization header, trimmed. Null when the
 * header carries no bearer credentials: it is absent or blank, names another scheme, or is the
 * scheme alone.
 */
function bearerCredentials(authorization: unknown): string | null {
  if (typeof authorization !== 'string') return null;
  return /^bearer(?:\s+(\S.*))?$/i.exec(authorization.trim())?.[1] ?? null;
}

function checkBearer(authorization: unknown, reg: Pick<CentralRegistry, 'byToken'>): GateResult {
  const credentials = bearerCredentials(authorization);
  if (credentials === null) return refuse('NO_TOKEN');
  // A token is one word. A longer value is not a token, and is never cut down to its first word.
  const central = /\s/.test(credentials) ? null : reg.byToken(credentials);
  // Only a record passes: any other answer (null, undefined, any falsy value) is no central.
  return central ? { ok: true, central } : refuse('BAD_TOKEN');
}

/**
 * May this request call /mcp, and as which central? The answer is the live central that holds the
 * request's bearer token, or the first refusal in the order the header comment gives. `central` is
 * the registry's copy of the record, token included: the caller must not log or send it on.
 */
export function checkMcpRequest(
  req: IncomingMessage,
  reg: Pick<CentralRegistry, 'byToken'>,
): GateResult {
  if (!isLocalRequest(req)) return refuseNonLocal(req);
  return checkBearer(req.headers.authorization, reg);
}
