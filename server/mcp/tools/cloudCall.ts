// tools/cloudCall.ts — how the cloud tools (cloud.ts, cloudProjects.ts and the P6 writes) call AASC's own cloud routes
// under `/api/resources/cloud`, and how they word what goes wrong.
//
// Most of those routes are tied to the account and connection a caller has *reviewed*: the dashboard reads them
// from `GET /resources/cloud/status` and names them in `x-aasc-cloud-*` headers on every call (the notes and
// alias routes read `x-aasc-notes-*` instead), so a stale tab cannot act as another account. A tool does the same:
// it reads the status, then asks as that account. A read changes nothing, so reviewing is just reading.
//
// `boundTo` and `boundGet` learn the live binding themselves. A write that waits for the person (P6-6, cloudWrite.ts)
// acts as the account the person reviewed instead: its `confirm` reads the connection with `reviewAccount`, names that
// account on the card and puts it in the fingerprint; after the allow the gate asks `confirm` again, so an account
// switched meanwhile is CHANGED and nothing runs; and its `run` sends the binding that recheck recorded
// (`approvedAccount`), never `boundTo` or `boundGet`. The route's own 409 `connection_changed` is the second wall. A
// write with no card (a plan, a mapping, a check) names the live binding through `liveAccount`, because a plan is
// itself the review a later card shows, and the route refuses a plan's run under another account. Only cloudWrite.ts
// calls `boundTo` among the P6 modules (test/mcp/cloudToolSources.test.ts). (`cloud_aliases_status` posts, but only to
// ask; it changes nothing.)
//
// The cloud routers answer `{ success: false, error: { code, message } }`, an object the loopback client cannot take a
// message from, so the words come from here. The messages are the server's own fixed sentences, never an echo of
// what a caller sent, and are cut short.

import type { InternalQuery, InternalResponse } from '../client.js';
import type { ToolContext } from '../registry.js';
import { ToolError } from '../types.js';
import { clipText, isRecord, unwrap } from './define.js';
import { num, routeMissing, str } from './shape.js';

export const CLOUD = '/resources/cloud';

const MESSAGE_MAX = 200;

/** The account and connection a call names: what the dashboard calls the reviewed binding. */
export interface CloudBinding {
  backendOrigin: string;
  accountId: string;
  generation: number;
}

export type HeaderFamily = 'cloud' | 'notes';

/** The headers that name a binding: `x-aasc-cloud-*` for the cloud routes, `x-aasc-notes-*` for the notes and aliases. */
export function bindingHeaders(binding: CloudBinding, family: HeaderFamily = 'cloud'): Record<string, string> {
  return {
    [`x-aasc-${family}-backend`]: binding.backendOrigin,
    [`x-aasc-${family}-account`]: binding.accountId,
    [`x-aasc-${family}-generation`]: String(binding.generation),
  };
}

// ---------------------------------------------------------------------------
// Words for what went wrong
// ---------------------------------------------------------------------------

/** The route's own sentence (`error.message`, or `error` when it is text), cut short; the status when it says nothing. */
export function routeWords(r: InternalResponse<unknown>): string {
  const error = isRecord(r.data) ? r.data.error : undefined;
  const said = isRecord(error) ? str(error.message) : typeof error === 'string' ? error : null;
  return clipText(said !== null && said !== '' ? said : (r.error ?? `HTTP ${r.status}`), MESSAGE_MAX).text;
}

/** A failed cloud call as the refusal a central reads, by what its status means. */
export function cloudFailure(r: InternalResponse<unknown>): ToolError {
  const words = routeWords(r);
  switch (r.status) {
    case 0:
      return new ToolError('UPSTREAM', `AASC could not be reached: ${words}`, 'Try it once more; if it fails again, tell the person.');
    case 400:
      return new ToolError('INVALID', words, 'Check the arguments in the tool’s input schema.');
    case 401:
    case 403:
      return new ToolError('UNAVAILABLE', words, 'AASC Cloud no longer accepts this Mac: the person has to reconnect it in RESOURCES → Cloud.');
    case 404:
      return new ToolError('NOT_FOUND', words, 'Check the id with the list tool for what you asked about.');
    case 409:
      return new ToolError('UNAVAILABLE', words, 'Call cloud_status for the connection, then ask again.');
    case 429:
      return new ToolError('UNAVAILABLE', words, 'AASC Cloud is limiting requests: wait a little, then ask again.');
    case 502:
    case 503:
      return new ToolError('UNAVAILABLE', words, 'AASC Cloud or its backend is not answering: try again in a moment.');
    default:
      return new ToolError('UPSTREAM', words, 'Try it once more; if it fails again, tell the person (the details are in the AASC log).');
  }
}

/**
 * Is this cloud route not in this build of AASC? The answers `routeMissing` knows (the app's page, 404, 415) and one more
 * that only the cloud project routes give: a project router with no literal route for `/projects/candidates` or
 * `/projects/github-accounts` hands the word to `/projects/:id`, whose id check throws, and its error handler answers 400
 * `invalid_request`. A tool may read that 400 as a missing route only when it sends nothing a 400 could be about (these
 * two take no input); any other tool keeps it as INVALID.
 */
export function cloudRouteMissing(r: InternalResponse<unknown>): boolean {
  if (routeMissing(r)) return true;
  if (r.ok || r.status !== 400) return false;
  const error = isRecord(r.data) ? r.data.error : undefined;
  return isRecord(error) && error.code === 'invalid_request';
}

/**
 * What a cloud route answered, without its envelope. A failure is worded by `cloudFailure`. An answer with no JSON
 * in it is AASC without a cloud connector (the app's own page answers an unknown route): UNAVAILABLE.
 */
export function cloudBody<T = unknown>(r: InternalResponse<unknown>): T {
  if (!r.ok) throw cloudFailure(r);
  if (r.data === null || r.data === undefined) {
    throw new ToolError('UNAVAILABLE', 'AASC Cloud is not available in this build of AASC.', 'Use cloud_status to see whether it is connected.');
  }
  return unwrap<T>(r);
}

// ---------------------------------------------------------------------------
// The connection
// ---------------------------------------------------------------------------

export type CloudState = 'connected' | 'disconnected' | 'offline' | 'revoked' | 'unknown';
const STATES: ReadonlySet<string> = new Set(['connected', 'disconnected', 'offline', 'revoked']);

export interface CloudConnection extends CloudBinding {
  deviceId: string | null;
  deviceName: string | null;
  accountEmail: string | null;
}

export interface CloudStatus {
  state: CloudState;
  connection: CloudConnection | null;
  lastError: string | null;
}

/** The status route's answer, read loosely: a connection without a backend, an account or a generation is none. */
export function readStatus(body: unknown): CloudStatus {
  const status = isRecord(body) ? body : {};
  const c = isRecord(status.connection) ? status.connection : null;
  const backendOrigin = c === null ? null : str(c.backendOrigin);
  const accountId = c === null ? null : str(c.accountId);
  const generation = c === null ? null : num(c.generation);
  const connection: CloudConnection | null =
    c !== null && backendOrigin && accountId && generation !== null && Number.isSafeInteger(generation) && generation >= 0
      ? { backendOrigin, accountId, generation, deviceId: str(c.deviceId), deviceName: str(c.deviceName), accountEmail: str(c.accountEmail) }
      : null;
  const state = str(status.state) ?? '';
  const lastError = str(status.lastError);
  return {
    state: STATES.has(state) ? (state as CloudState) : 'unknown',
    connection,
    lastError: lastError === null || lastError === '' ? null : lastError,
  };
}

/** `GET /resources/cloud/status`: the one cloud route that needs no binding. */
export async function cloudStatus(ctx: ToolContext): Promise<CloudStatus> {
  return readStatus(cloudBody(await ctx.client.get(`${CLOUD}/status`, undefined, { signal: ctx.signal })));
}

/**
 * The live connection's binding, or a refusal that says this Mac is not connected: what a bound read names, and a write
 * with no card, through `liveAccount` (cloudWrite.ts). Never in the run of a write that waits for the person: that
 * sends the binding the person reviewed (`approvedAccount`).
 */
export async function boundTo(ctx: ToolContext): Promise<CloudBinding> {
  const { connection } = await cloudStatus(ctx);
  if (connection === null) {
    throw new ToolError('UNAVAILABLE', 'This Mac is not connected to AASC Cloud.', 'Ask the person to connect it in RESOURCES → Cloud; cloud_status shows the state.');
  }
  return connection;
}

/**
 * A bound READ: learns the live connection, then asks the route as that account. Never in the run of a write that waits
 * for the person: that names the binding the person reviewed, not whichever one is live now (see the head of this file).
 */
export async function boundGet(
  ctx: ToolContext,
  path: string,
  query?: InternalQuery,
  family: HeaderFamily = 'cloud',
): Promise<InternalResponse<unknown>> {
  const binding = await boundTo(ctx);
  return ctx.client.get(path, query, { headers: bindingHeaders(binding, family), signal: ctx.signal });
}
