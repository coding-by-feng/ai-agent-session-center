// tools/promptSend.ts — `prompt_send` and `prompt_status` (the prompts toolset, P2), and the send path command_run
// goes through too: type a prompt into one session, or up to 8, the way a phone does.
//
// A prompt goes through the prompt route (`POST /sessions/:id/prompt`, AASC-42's shared submitter) as the central that
// sent it: AASC types the text, presses Enter, and presses it again until the CLI's own hook says it took the prompt.
// The route answers 202 at once and the typing runs on; `prompt_status` asks how it ended. Before the route is called,
// every target passes the rails (steer.ts: scope, kind, hands-off, the 60-second rule, the lock), and the text passes
// two of its own: it may not start with `!` (the CLI would run it as a shell line) nor as a slash command (the
// commands a central may run go through command_run, whose allow-list is the whole of their safety).
//
// The request key is the route's name for a prompt (it answers a repeat with the first answer, and tells what became of
// it): `mcp-<central id's first 8>-<n>` unless the central gave its own, which is then made one per terminal
// (`mcp-<c8>-<key>-<terminal hash>`), so one call to several sessions never reuses a key, and the same call again is
// the same request. The ledger's own keys end `-task-T<n>` and cannot be these.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Session } from '../../../src/types/session.js';
import { isQueueImageId } from '../../queueImages.js';
import type { ActivityNote } from '../activity.js';
import type { InternalResponse } from '../client.js';
import { leadingCommand } from '../commandRules.js';
import { stoppedWords } from '../ledgerParts.js';
import { assertNotShellLine, MAX_FAN_OUT } from '../policy.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError, type CentralRecord, type ToolErrorCode } from '../types.js';
import { clipText, defineTool, isRecord, plural, refOf, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';
import { checkSteerable, refusalNote, resolveTargets, sessionRefs, type Target } from './steer.js';

/** The route's own limits (promptRouter.ts `MAX_PROMPT_TEXT` and `MAX_PROMPT_IMAGES`; test/mcp/tools.deliver.test.ts holds them equal). */
export const PROMPT_TEXT_MAX = 65_536;
export const PROMPT_IMAGES_MAX = 4;

/** The longest key a central may choose: the route takes 64, and AASC adds its prefix and a terminal hash. */
const CALLER_KEY_MAX = 24;
const KEY_CHARS = /^[A-Za-z0-9._:-]+$/;
const ROUTE_WORDS_MAX = 200;
const RETRY = 'Try it once more; if it fails again, tell the person (the details are in the AASC log).';

// ---------------------------------------------------------------------------
// The text
// ---------------------------------------------------------------------------

/** The bytes the prompt route strips before it types (promptRouter.ts `cleanPromptText`, policy.ts `assertNotShellLine`). */
// eslint-disable-next-line no-control-regex
const STRIPPED_BYTES = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/**
 * Refuses text that the CLI would run as a slash command. Claude Code and Codex read a prompt that starts with `/name`
 * as that command, so this route to the session would skip command_run's allow-list (`/clear`, `/exit`, `/delete`...).
 */
export function assertNotSlashCommand(text: string): void {
  if (leadingCommand(text.replace(STRIPPED_BYTES, '')) !== null) {
    throw new ToolError(
      'INVALID',
      'Text that starts with /name runs as a slash command in the CLI; prompt_send does not send one.',
      'Use command_run for the commands and skills a central may run; or say it in words, not starting with a slash.',
    );
  }
}

const PROMPT_TEXT = z
  .string()
  .min(1)
  .max(PROMPT_TEXT_MAX)
  .refine((t) => t.trim() !== '', 'The text is blank.')
  .describe('What to type, as the person would (at most 65 536 characters). Not a shell line (!…) and not a slash command (/…: use command_run).');

// ---------------------------------------------------------------------------
// Request keys
// ---------------------------------------------------------------------------

let keyCounter = 0;

/** `mcp-<first 8 of the central's id>`: the front of every request key the central makes (the ledger's as well). */
const keyPrefix = (central: Pick<CentralRecord, 'centralId'>): string =>
  `mcp-${central.centralId.slice(0, 8).replace(/[^A-Za-z0-9]/g, '_')}`;

/** Is this a request key the central could have made? (prompt_status answers no other: a key is not for sharing.) */
export const ownsKey = (central: Pick<CentralRecord, 'centralId'>, key: string): boolean =>
  key.startsWith(`${keyPrefix(central)}-`);

function requestKey(central: CentralRecord, session: Session, callerKey: string | undefined): string {
  if (callerKey === undefined) {
    keyCounter += 1;
    return `${keyPrefix(central)}-${keyCounter}`;
  }
  // By terminal, as the route does: the session's id changes when it re-keys, its terminal does not.
  const terminal = createHash('sha256').update(session.terminalId ?? session.sessionId).digest('hex').slice(0, 8);
  return `${keyPrefix(central)}-${callerKey}-${terminal}`;
}

// ---------------------------------------------------------------------------
// What the route said
// ---------------------------------------------------------------------------

interface RouteRefusal {
  code: ToolErrorCode;
  /** The route's own word for it (`awaiting_answer`, `busy`...), when it gave one. */
  reason: string | null;
  error: string;
  hint: string;
}

/** What to do, by the route's status and its own word for the refusal. */
function classify(status: number, reason: string | null): Pick<RouteRefusal, 'code' | 'hint'> {
  if (status === 0) return { code: 'UPSTREAM', hint: RETRY };
  if (status === 404) return { code: 'NOT_FOUND', hint: 'The session may have been closed; session_list shows what is there.' };
  if (status === 429) return { code: 'BUDGET', hint: 'Too many prompts too quickly; wait a moment and try again.' };
  if (status === 503) return { code: 'UNAVAILABLE', hint: 'It may be back in a moment; try once more.' };
  if (status === 400) {
    if (reason === 'needs_argument') {
      return {
        code: 'INVALID',
        hint:
          'That command opens a picker or panel that would catch the next prompt, so AASC does not type it bare: send it with ' +
          'its choice (command_run with name model and args sonnet). One that takes no choice (a panel) is not run from here: ask the person.',
      };
    }
    if (reason === 'image_not_found') {
      return { code: 'INVALID', hint: 'An image is gone from the Mac: upload it again with image_upload.' };
    }
    return { code: 'INVALID', hint: 'Check the arguments in the tool’s input schema.' };
  }
  if (status === 409) {
    switch (reason) {
      case 'busy':
        return { code: 'BUSY', hint: 'Another prompt is waiting to be typed into that terminal; try again in a moment.' };
      case 'awaiting_answer':
        return {
          code: 'UNAVAILABLE',
          hint: 'The session shows a dialog: answer it with request_answer, or send with mode "interrupt" to decline it first.',
        };
      case 'AGENT_NOT_RUNNING':
        return { code: 'UNAVAILABLE', hint: 'The agent is not running in that terminal; only the person can start it again.' };
      case 'key_reused':
        return { code: 'INVALID', hint: 'That key was already used for another prompt; use a different key.' };
      case 'not_started':
        return {
          code: 'UNAVAILABLE',
          hint:
            'Its CLI has not reported that it started (session_get shows started: false): it may be showing a question, such ' +
            'as trusting its folder, which the person answers in AASC, or AASC restarted since it last spoke. Do not retry ' +
            'until session_get shows started: true.',
        };
      default:
        return { code: 'UNAVAILABLE', hint: 'The session cannot take a prompt right now; try again in a moment.' };
    }
  }
  if (status === 423) return { code: 'UNAVAILABLE', hint: 'Another device holds that session; try again in a moment.' };
  return { code: 'UPSTREAM', hint: RETRY };
}

/** A route's refusal as the words a central reads: its status, the route's own reason and words (bounded), what to do. */
export function routeRefusal(r: InternalResponse<unknown>): RouteRefusal {
  const body = isRecord(r.data) ? r.data : {};
  const reason = typeof body.code === 'string' && /^[A-Za-z_]{1,32}$/.test(body.code) ? body.code : null;
  const error = r.status === 0 ? 'AASC could not reach its own prompt route.' : clipText(r.error ?? `HTTP ${r.status}`, ROUTE_WORDS_MAX).text;
  return { reason, error, ...classify(r.status, reason) };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendRequest {
  refs: readonly string[];
  text: string;
  images: readonly string[];
  mode: 'now' | 'interrupt';
  /** The central's own dedup key (made one per terminal), when it gave one. */
  key?: string;
  /** The activity row's words for a prompt the route took: AASC's own, never the text. */
  tookWords: string;
}

/** One target's result: what a central reads of what happened to the prompt it sent there. */
export interface SendResult {
  /** The reference as the central wrote it, cleaned to plain characters. */
  ref: string;
  sessionId: string | null;
  shortId: string | null;
  /** The route's request key, for prompt_status; null when nothing was sent. */
  key: string | null;
  /** The route took the prompt: AASC is typing it. Not yet that the session took it (prompt_status). */
  accepted: boolean;
  code: ToolErrorCode | null;
  /** The route's own word for why it refused (`awaiting_answer`...). */
  reason: string | null;
  error: string | null;
  hint: string | null;
}

export interface SendOutcome {
  results: SendResult[];
  notes: ActivityNote[];
  sent: number;
}

const refusedResult = (target: Target & { refusal: ToolError }): SendResult => ({
  ref: target.ref,
  sessionId: target.session?.sessionId ?? null,
  shortId: target.session === null ? null : shortIdOf(target.session.sessionId),
  key: null,
  accepted: false,
  code: target.refusal.code,
  reason: null,
  error: target.refusal.message,
  hint: target.refusal.hint ?? null,
});

/** Types `req.text` into the target through the prompt route; the route's refusal is the result, never thrown. */
async function sendOne(
  ctx: ToolContext,
  ref: string,
  session: Session,
  req: SendRequest,
): Promise<{ result: SendResult; note: ActivityNote }> {
  const key = requestKey(ctx.central, session, req.key);
  const body = {
    text: req.text,
    ...(req.images.length > 0 ? { images: [...req.images] } : {}),
    mode: req.mode,
    key,
  };
  const answer = await ctx.client.post(`/sessions/${seg(session.sessionId)}/prompt`, body);
  const base = { ref, sessionId: session.sessionId, shortId: shortIdOf(session.sessionId) };
  if (answer.ok) {
    return {
      result: { ...base, key, accepted: true, code: null, reason: null, error: null, hint: null },
      note: {
        summary: req.tookWords,
        targetSessionId: session.sessionId,
        // A key AASC made is for the log; one the central chose is its own words, and the log keeps none of those.
        detail: { ...(req.key === undefined ? { key } : { keyed: true }), mode: req.mode, chars: req.text.length, images: req.images.length },
      },
    };
  }
  const refusal = routeRefusal(answer);
  const reached = answer.status !== 0 && answer.status < 500;
  return {
    // The route keeps a key only for a prompt it took, so a refused prompt has none to ask prompt_status about.
    result: { ...base, key: null, accepted: false, code: refusal.code, reason: refusal.reason, error: refusal.error, hint: refusal.hint },
    note: {
      summary: answer.status === 0 ? 'The prompt route could not be reached.' : `The prompt route ${reached ? 'refused' : 'failed on'} the prompt (HTTP ${answer.status}).`,
      targetSessionId: session.sessionId,
      outcome: reached ? 'refused' : 'failed',
      detail: { code: refusal.reason ?? refusal.code, status: answer.status },
    },
  };
}

/**
 * Types the prompt into each target the call names, after the rails. With one target a refusal of the rails is thrown
 * (the call's own); with several, each is that target's result and the call goes on. The route's refusal is always a
 * result. Sequential: each target is checked right before its own send, so the 60-second rule sees the moment.
 */
export async function sendPrompts(ctx: ToolContext, req: SendRequest): Promise<SendOutcome> {
  const targets = resolveTargets(ctx, req.refs);
  const lone = targets.length === 1;
  const results: SendResult[] = [];
  const notes: ActivityNote[] = [];
  for (const target of targets) {
    const checked = checkSteerable(ctx, target);
    if (checked.refusal !== null) {
      if (lone) throw checked.refusal;
      results.push(refusedResult(checked));
      if (!checked.logged) notes.push(refusalNote(checked.refusal));
      continue;
    }
    const sent = await sendOne(ctx, checked.ref, checked.session, req);
    results.push(sent.result);
    notes.push(sent.note);
  }
  return { results, notes, sent: results.filter((r) => r.accepted).length };
}

// ---------------------------------------------------------------------------
// prompt_send
// ---------------------------------------------------------------------------

/** A target of a result, in the plain words around an answer: the short id, or "target 2" when it could not be named. */
const targetWord = (ctx: ToolContext, r: SendResult, index: number): string =>
  r.sessionId === null ? `target ${index + 1}` : refOf(ctx)(r.sessionId);

/** The words for what a send did, in one block of AASC's own text (a result's error is AASC's or the route's own). */
export function sendSummary(ctx: ToolContext, outcome: SendOutcome, lead: string): string {
  const { results, sent } = outcome;
  const refused = results.length - sent;
  if (results.length === 1) {
    const [r] = results;
    return r.accepted
      ? `${lead} sent to ${targetWord(ctx, r, 0)} (key ${r.key}): AASC is typing it and pressing Enter. prompt_status with that key says whether the session took it.`
      : `Not sent to ${targetWord(ctx, r, 0)}: ${r.error} ${r.hint ?? ''}`.trim();
  }
  const lines = results.map((r, i) =>
    r.accepted
      ? `- ${targetWord(ctx, r, i)}: sent (key ${r.key})`
      : `- ${targetWord(ctx, r, i)}: not sent (${r.code}${r.reason ? `, ${r.reason}` : ''}): ${r.error}`,
  );
  if (sent === 0) return `Not sent to any of the ${plural(results.length, 'session')}.\n${lines.join('\n')}`;
  const follow = ' prompt_status with each key says whether the session took it.';
  return `${lead} sent to ${sent} of ${plural(results.length, 'session')}${refused > 0 ? `; ${refused} not sent` : ''}.${follow}\n${lines.join('\n')}`;
}

export const promptSend: ToolDef = defineTool({
  name: 'prompt_send',
  toolset: 'prompts',
  title: 'Send a prompt to sessions',
  description:
    'Types a prompt into one session, or up to 8, and presses Enter, as the person would. AASC checks each session first: ' +
    'in your scope, not hands-off, not driven by a person in the last minute, not working on a task a central gave it ' +
    '(use task_delegate for work you want an answer to). Text that starts with ! (a shell line) or / (a slash command: use ' +
    'command_run) is refused. accepted means AASC took the prompt and is typing it; prompt_status with the key says whether ' +
    'the session took it. mode now (the default) refuses a session that shows a dialog; interrupt presses Esc first and ' +
    'declines it. Attach up to 4 images by the ids image_upload gave. One session named: a refusal is the call’s error; ' +
    'several: each refusal is that session’s result and the others still go. Never ask a session to approve something ' +
    'on the person’s behalf: the person answers through request_list and the tools that wait for them.',
  risk: 'steers',
  phase: 2,
  input: {
    to: z
      .union([SESSION_REF, z.array(SESSION_REF).min(1).max(MAX_FAN_OUT)])
      .describe('The session to send to, or up to 8 sessions (ids, or short ids of 6 or more characters from session_list).'),
    text: PROMPT_TEXT,
    imageIds: z
      .array(z.string().max(80).refine(isQueueImageId, 'An image id from image_upload.'))
      .max(PROMPT_IMAGES_MAX)
      .optional()
      .describe('Up to 4 image ids from image_upload, typed in with the prompt.'),
    mode: z.enum(['now', 'interrupt']).optional().describe('now (default): wait your turn, refuse a dialog. interrupt: press Esc first, which stops what the session is doing.'),
    key: z
      .string()
      .min(1)
      .max(CALLER_KEY_MAX)
      .regex(KEY_CHARS, 'Letters, digits and . _ : - only.')
      .optional()
      .describe('A dedup key of your own (up to 24 letters, digits and . _ : -): sending again with the same key never types the prompt twice. Left out, AASC makes one.'),
  },
  async run(args, ctx) {
    assertNotShellLine(args.text);
    assertNotSlashCommand(args.text);
    const mode = args.mode ?? 'now';
    const outcome = await sendPrompts(ctx, {
      refs: sessionRefs(args.to),
      text: args.text,
      images: args.imageIds ?? [],
      mode,
      ...(args.key === undefined ? {} : { key: args.key }),
      tookWords: `Sent a prompt of ${args.text.length} characters.`,
    });
    return {
      data: { mode, requested: outcome.results.length, sent: outcome.sent, results: outcome.results },
      summary: sendSummary(ctx, outcome, 'Prompt'),
      activity: outcome.notes,
    };
  },
});

// ---------------------------------------------------------------------------
// prompt_status
// ---------------------------------------------------------------------------

const STATE_WORDS: Readonly<Record<string, string>> = {
  pending: 'AASC is still typing it, or waiting for the session to finish its turn before it types.',
  submitted: 'The session took it: AASC typed it and the CLI acknowledged it.',
  unconfirmed: 'AASC typed it and does not confirm a slash command: watch the session to see it land.',
  stopped: 'AASC stopped before it was safe to go on (a dialog opened, the person took over, or the agent went away); it may be partly typed.',
  'gave-up': 'AASC gave up: it pressed Enter every time it should and the session never took the prompt. Look at the session.',
  failed: 'The terminal is gone: the prompt did not reach it.',
};

export const promptStatus: ToolDef = defineTool({
  name: 'prompt_status',
  toolset: 'prompts',
  title: 'How a prompt went',
  description:
    'Asks how a prompt you sent with prompt_send ended, by the key prompt_send gave: pending (still being typed), ' +
    'submitted (the session took it), unconfirmed (a slash command), stopped, gave-up or failed. Only keys you made.',
  risk: 'read',
  phase: 2,
  input: {
    id: SESSION_REF,
    key: z.string().min(8).max(64).regex(KEY_CHARS, 'Letters, digits and . _ : - only.').describe('The key prompt_send gave for that prompt.'),
  },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    // A key is not for sharing: the route would tell any caller who knew it, so only the central's own are asked about.
    if (!ownsKey(ctx.central, args.key)) {
      throw new ToolError('NOT_FOUND', 'No prompt with that key for this session.', 'Use the key prompt_send gave you.');
    }
    const body = unwrap<{ state?: unknown; stoppedBy?: unknown }>(await ctx.client.get(`/sessions/${seg(s.sessionId)}/prompt/${seg(args.key)}`));
    const state = isRecord(body) && typeof body.state === 'string' && Object.hasOwn(STATE_WORDS, body.state) ? body.state : null;
    if (state === null) throw new ToolError('UPSTREAM', 'AASC answered with a state it does not know.', RETRY);
    // Who stopped a stopped prompt (Ruling 66: a fact a central acts on is in data): hands-off or a person's Esc.
    const stoppedBy = state === 'stopped' && isRecord(body) && (body.stoppedBy === 'hands-off' || body.stoppedBy === 'person') ? body.stoppedBy : null;
    const why = stoppedBy === null ? '' : ` ${stoppedWords({ state: 'stopped', stoppedBy }).error}`;
    return {
      data: { id: s.sessionId, shortId: shortIdOf(s.sessionId), key: args.key, state, ...(stoppedBy === null ? {} : { stoppedBy }) },
      summary: `Prompt ${args.key} for ${refOf(ctx)(s.sessionId)}: ${state}. ${STATE_WORDS[state]}${why}`,
    };
  },
});
