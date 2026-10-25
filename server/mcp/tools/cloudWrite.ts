// tools/cloudWrite.ts — what every P6 cloud write shares (plan 2026-10-25, the cloud toolset's writes): the rule
// sentences their descriptions are built from, the account a call acts as, how a write is sent, the cloud's refusals
// in AASC's words, a route a build lacks, the folder rule, the call budget, and the card's digest and detail.
//
// The account (P6-6). The routes act only as the account a call names in its binding headers (cloudCall.ts). A tool
// that waits for the person names the account the person reviewed: its `confirm` reads the live connection with
// `reviewAccount`, which records it on the call's context (one per call) and gives the card its words and the
// fingerprint its key. After the allow, the gate asks `confirm` again on the same context (P5-3), so the record is the
// recheck's, and an account switched meanwhile changes the summary and the fingerprint: CHANGED, nothing runs. `run`
// sends what that recheck recorded (`approvedAccount`), and refuses when the person did not allow this call. A write
// with no card (a plan, a mapping, a check) names the live binding (`liveAccount`): a plan is itself the review a later
// card shows, and the route refuses a plan's run under another account.
//
// The cloud's refusals (P6-20) keep the route's own fixed sentence and give its code in `data.cloudCode`, with a hint
// for the codes a central can act on. A route only newer builds have (P6-11) reads as missing in every way an older
// build answers it (cloudCall.ts `cloudRouteMissing`), but a cloud router's own `not_found` stays NOT_FOUND.
//
// The folder rule (P6-14) reads only the path's words: absolute or `~/`, under home (home itself only when asked for),
// not in ~/Library or below a hidden segment. The route then confines the real path itself. No refusal repeats a path.
//
// This module, like every P6 module, imports nothing from server/cloud, the file system, child processes, sockets or
// HTTP, and calls no fetch (test/mcp/cloudToolSources.test.ts).

import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { InternalResponse } from '../client.js';
import type { ToolContext } from '../registry.js';
import { isWithin } from '../scope.js';
import { ToolError } from '../types.js';
import {
  bindingHeaders,
  boundTo,
  cloudFailure,
  cloudRouteMissing,
  cloudStatus,
  type CloudBinding,
  type HeaderFamily,
} from './cloudCall.js';
import { isRecord, unwrap } from './define.js';
import { withheld } from './withheldPaths.js';

// ---------------------------------------------------------------------------
// The rules every P6 description carries (Ruling 65)
// ---------------------------------------------------------------------------

export const CLOUD_CALLS_PER_MINUTE = 20;

/** The rule sentences every P6 description is built from (Ruling 65: Codex never shows its model the instructions). */
export const CLOUD_RULES = Object.freeze({
  global: 'Only a global central may do this; a room or project central is DENIED.',
  waits: 'It waits for the person on the Mac first (an AASC card): NEEDS_CONFIRMATION means call confirm_wait with data.confirmId.',
  ownPlan: 'Only a plan you made yourself in the last 30 minutes.',
  ownJob: 'Only a job you started yourself (in the last 24 hours).',
  job: 'It answers at once with data.jobId: follow it with cloud_job_get (waitSec up to 45).',
  newer: 'Only newer builds of AASC have this: otherwise UNAVAILABLE.',
});

/** Short id: the first 8 characters. */
export const short = (id: string): string => id.slice(0, 8);

// ---------------------------------------------------------------------------
// The account a call acts as (P6-6)
// ---------------------------------------------------------------------------

export interface ReviewedAccount {
  binding: CloudBinding;
  /** `${backendOrigin}|${accountId}|${generation}`: what fingerprints carry. */
  key: string;
  /** For card summaries: the account's email, else its id's first 8 characters. */
  label: string;
}

/** `${backendOrigin}|${accountId}|${generation}`: a binding as fingerprints and the memo carry it. */
export const accountKeyOf = (b: CloudBinding): string => `${b.backendOrigin}|${b.accountId}|${b.generation}`;

/** An email the card can name as it is; anything else is named by the account id. */
const EMAIL = /^[^\s@<>"'`]{1,64}@[^\s@<>"'`]{1,190}$/;

/** The longest email a card names: a summary is cut at 300, and its last clauses (memory, ~/.claude, skips) matter most. */
const LABEL_MAX = 60;

/** How a card names an account: its email when it is one of at most LABEL_MAX characters, else its id's first 8. */
export function accountLabelOf(accountEmail: string | null, accountId: string): string {
  return accountEmail !== null && accountEmail.length <= LABEL_MAX && EMAIL.test(accountEmail) ? accountEmail : short(accountId);
}

/** What `confirm` reviewed on a call's context (one per call): what `run` of that call acts as. */
const reviewed = new WeakMap<ToolContext, ReviewedAccount>();

const notConnected = (): ToolError =>
  new ToolError(
    'UNAVAILABLE',
    'This Mac is not connected to AASC Cloud.',
    'Ask the person to connect it in RESOURCES → Cloud; cloud_status shows the state.',
  );

/**
 * For `confirm`: the live connection, recorded on this call's context, or UNAVAILABLE when the Mac is not connected
 * (offline and revoked included). The gate's recheck calls it again on the same context, so `run` acts as the recheck's.
 */
export async function reviewAccount(ctx: ToolContext): Promise<ReviewedAccount> {
  reviewed.delete(ctx);
  const { state, connection } = await cloudStatus(ctx);
  if (state !== 'connected' || connection === null) throw notConnected();
  const { backendOrigin, accountId, generation, accountEmail } = connection;
  const binding: CloudBinding = { backendOrigin, accountId, generation };
  const account: ReviewedAccount = {
    binding,
    key: accountKeyOf(binding),
    label: accountLabelOf(accountEmail, accountId),
  };
  reviewed.set(ctx, account);
  return account;
}

/**
 * For `run` of a waiting tool: the account the recheck recorded on this context. INVALID "That changed; call again."
 * when the person did not allow this call, or when no `confirm` of this call reviewed one.
 */
export function approvedAccount(ctx: ToolContext): ReviewedAccount {
  const account = reviewed.get(ctx);
  if (!ctx.allowedByPerson() || account === undefined) {
    throw new ToolError('INVALID', 'That changed; call again.', 'Call the tool again: the person is asked about it as it is now.');
  }
  return account;
}

/** A write with no card: the live binding (boundTo), named here so the source test can tell the two apart. */
export async function liveAccount(ctx: ToolContext): Promise<CloudBinding> {
  return boundTo(ctx);
}

// ---------------------------------------------------------------------------
// Sending, and what came back
// ---------------------------------------------------------------------------

/** client.post / put with the binding headers, JSON (`{}` for no body: the routes answer 415 without it) and ctx.signal. */
export function cloudSend(
  ctx: ToolContext,
  method: 'post' | 'put',
  path: string,
  body: unknown,
  binding: CloudBinding,
  family: HeaderFamily = 'cloud',
): Promise<InternalResponse<unknown>> {
  const json = body === undefined || body === null ? {} : body;
  const options = { headers: bindingHeaders(binding, family), signal: ctx.signal };
  return method === 'post' ? ctx.client.post(path, json, options) : ctx.client.put(path, json, options);
}

const CODE = /^[a-z_]{1,40}$/;

/** The route's `error.code` when it is lower-case words of at most 40 characters; null otherwise (or when `error` is text). */
function cloudCodeOf(r: InternalResponse<unknown>): string | null {
  const error = isRecord(r.data) ? r.data.error : undefined;
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' && CODE.test(code) ? code : null;
}

/** What a central can do about a refusal, by the cloud's code (P6-20); any other code keeps `cloudFailure`'s. */
const HINTS: Readonly<Record<string, string>> = {
  connection_changed: 'Call cloud_status, then plan again.',
  review_required: 'Make a new plan.',
  version_conflict: 'Make a new plan.',
  project_mapping_required: 'Call cloud_project_get_copy or cloud_project_associate first.',
  busy: 'Wait for its job (cloud_job_get).',
  rate_limited: 'Wait a minute.',
  publication_blocked: 'Make a new plan: the plan tool shows what is blocked now.',
  installation_blocked: 'Make a new plan: the plan tool shows what is blocked now.',
};

/** `cloudFailure(r)` with the route's code in `data.cloudCode` and, for the codes above, their hint. */
export function cloudWriteFailure(r: InternalResponse<unknown>): ToolError {
  const base = cloudFailure(r);
  const cloudCode = cloudCodeOf(r);
  const hint = (cloudCode === null ? undefined : HINTS[cloudCode]) ?? base.hint;
  return new ToolError(base.code, base.message, hint, { cloudCode });
}

/**
 * cloudBody for a write: the data of the envelope. On a missing route (P6-11: 404, the app's page, 415, the
 * `candidates` 400) throws UNAVAILABLE in `missing`'s words when they are given (`what` is the whole sentence, "This
 * build of AASC cannot …"); a cloud router's own 404 `not_found` is never a missing route. Any other failure throws
 * `cloudWriteFailure`.
 */
export function cloudWriteBody<T = unknown>(r: InternalResponse<unknown>, missing?: { what: string; hint: string }): T {
  if (missing !== undefined && cloudRouteMissing(r) && !(r.status === 404 && cloudCodeOf(r) === 'not_found')) {
    throw new ToolError('UNAVAILABLE', missing.what, missing.hint);
  }
  if (!r.ok) throw cloudWriteFailure(r);
  if (r.data === null || r.data === undefined) {
    throw new ToolError('UNAVAILABLE', 'AASC Cloud is not available in this build of AASC.', 'Use cloud_status to see whether it is connected.');
  }
  return unwrap<T>(r);
}

// ---------------------------------------------------------------------------
// The call budget (P6-15)
// ---------------------------------------------------------------------------

const MINUTE_MS = 60_000;

/** When each central made a P6 call lately, in ms, oldest first. */
const callTimes = new Map<string, readonly number[]>();

/** Forgets every central's calls (tests). */
export function resetCloudBudget(): void {
  callTimes.clear();
}

/**
 * Counts a non-read P6 call for this central, or throws BUDGET when it has made CLOUD_CALLS_PER_MINUTE in the last minute
 * (the backend allows a device about 60 writes a minute, and a runaway central must not spend them). Every P6 tool
 * calls it in one place (P6-40): after its own refusals that need no cloud (global, ownership, input), and right before
 * its first cloud call, so a call refused before the cloud spends nothing and a BUDGET calls nothing. A waiting tool
 * counts in its `confirm`, before any card, so the gate's recheck counts too.
 */
export function spendCloudCall(ctx: ToolContext): void {
  const { centralId } = ctx.central;
  const now = ctx.now();
  const recent = (callTimes.get(centralId) ?? []).filter((t) => t > now - MINUTE_MS);
  if (recent.length >= CLOUD_CALLS_PER_MINUTE) {
    callTimes.set(centralId, recent);
    throw new ToolError('BUDGET', `A central makes at most ${CLOUD_CALLS_PER_MINUTE} cloud changes a minute.`, 'Wait a minute, then try again.');
  }
  callTimes.set(centralId, [...recent, now]);
}

// ---------------------------------------------------------------------------
// The folder rule (P6-14)
// ---------------------------------------------------------------------------

const notAbsolute = (): ToolError =>
  new ToolError('INVALID', 'A folder is an absolute path, or starts with ~/.', 'Pass the full path of a folder in the person’s home folder.');

const notUnderHome = (): ToolError =>
  new ToolError(
    'INVALID',
    'A folder must be in the person’s home folder, not in ~/Library or a hidden folder.',
    'Pass the full path of a folder in the person’s home folder (absolute, or starting with ~/).',
  );

const homeItself = (): ToolError =>
  new ToolError('INVALID', 'The home folder itself cannot be used here.', 'Pass a folder inside the person’s home folder.');

/**
 * P6-14: the absolute folder a central named, or INVALID in words that never repeat it. Absolute or `~/`; under the
 * person's home folder, and the home folder itself only with `allowHome` (get_copy's parent); not in ~/Library or below
 * a hidden segment (withheldPaths.ts `withheld`). By the path's words only: the route confines the real path again.
 */
export async function cloudFolder(raw: string, opts: { allowHome?: boolean } = {}): Promise<string> {
  if (raw.includes('\0')) throw notAbsolute();
  const home = resolve(homedir());
  const expanded = raw === '~' || raw.startsWith('~/') ? join(home, raw.slice(1)) : raw;
  if (!isAbsolute(expanded)) throw notAbsolute();
  const folder = resolve(expanded);
  if (!isWithin(folder, home)) throw notUnderHome();
  if (folder === home) {
    if (opts.allowHome === true) return folder;
    throw homeItself();
  }
  if (withheld(folder, home)) throw notUnderHome();
  return folder;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** sha256 hex, first 40, of JSON.stringify(parts): what a fingerprint carries of a list the card was made from. */
export function cardDigest(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
}

/** The most a card's detail holds: the confirmation book's own cut (confirm.ts CONFIRM_DETAIL_MAX). */
const DETAIL_MAX = 2_000;
/** Room kept at the end of a cut detail for its "… and N more" line. */
const MORE_ROOM = 24;

/** A card's detail, one row per line; past 2 000 characters, as many rows as fit and then how many more there are. */
export function cardDetail(rows: readonly string[]): string {
  const whole = rows.join('\n');
  if (whole.length <= DETAIL_MAX) return whole;
  const kept: string[] = [];
  let size = 0;
  for (const row of rows) {
    if (size + row.length + 1 > DETAIL_MAX - MORE_ROOM) break;
    kept.push(row);
    size += row.length + 1;
  }
  return [...kept, `… and ${rows.length - kept.length} more`].join('\n');
}
