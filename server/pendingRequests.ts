// pendingRequests.ts — what a waiting session is asking, structured (AASC-43).
//
// The PermissionRequest hook (Claude and Codex both send it) and PreToolUse of
// AskUserQuestion / ExitPlanMode carry the tool and its input. This turns them into
// `session.pendingRequest`: an id'd request a phone card can show and answer through
// requestAnswer.ts. The approval timer and the permission_prompt Notification only
// GUESS that the CLI waits: a guess carries no input, never replaces a request the
// CLI raised, and no card can answer it.
//
// Clearing errs early. A request left behind after its dialog closed would let an
// answer type a digit into the agent's prompt; one cleared too early only sends the
// user to the terminal. So without call ids on both sides, any PostToolUse of the
// same tool ends the request.

import { createHash, randomUUID } from 'crypto';
import type { PendingRequest, PendingRequestOption } from '../src/types/session.js';

type Kind = PendingRequest['kind'];
type Cli = PendingRequest['cli'];
type Source = PendingRequest['source'];

/** Input kept on a request; a phone shows it before the user allows anything. */
export const PENDING_INPUT_MAX_BYTES = 8 * 1024;
/** Edits are kept whole up to this, so the card can show the diff it allows. */
export const PENDING_EDIT_INPUT_MAX_BYTES = 64 * 1024;
/** A question is answered with one digit key, so at most nine choices. */
export const MAX_ANSWERABLE_OPTIONS = 9;
/** Ends any string this module shortened, so a card never shows a cut input as whole. */
export const INPUT_TRUNCATION_MARKER = '… [truncated]';

const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'apply_patch']);
/** PreToolUse of these means the CLI is about to ask the user. */
const ASKING_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);
/** A new turn, a finished turn, or a new / ended session: nothing is still being asked. */
const CLEARING_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd']);
const CALL_ENDS: ReadonlySet<string> = new Set(['PostToolUse', 'PostToolUseFailure']);
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1_000;

/** A hash of the full input each raised request came from, to tell one call from another. */
const inputKeys = new WeakMap<PendingRequest, string>();

export function requestKindOf(tool: string): Kind {
  if (tool === 'AskUserQuestion') return 'question';
  if (tool === 'ExitPlanMode') return 'plan';
  return 'permission';
}

/** The CLI a session's requests come from. Claude's hook sends no `cli_source`; another CLI gets no requests. */
export function requestCliOf(cliSource: string | null | undefined): Cli | null {
  if (!cliSource || cliSource === 'claude') return 'claude';
  return cliSource === 'codex' ? 'codex' : null;
}

/** A hook field is untrusted: only a non-empty string of sane length counts. */
function saneString(value: unknown, maxChars: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars ? value : undefined;
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

function cutStrings(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') return value.length > maxChars ? value.slice(0, maxChars) + INPUT_TRUNCATION_MARKER : value;
  if (Array.isArray(value)) return value.map((item) => cutStrings(item, maxChars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutStrings(item, maxChars)]));
  }
  return value;
}

/**
 * A copy of `input` that fits the tool's cap: whole when it fits, else with its long
 * strings cut (each to the same length, halving until it fits), else a cut preview of
 * the JSON when no string is long enough to matter.
 */
export function capRequestInput(tool: string, input: unknown): { input: unknown; truncated: boolean } {
  const json = input === undefined ? undefined : JSON.stringify(input);
  if (json === undefined) return { input: undefined, truncated: false };
  const max = EDIT_TOOLS.has(tool) ? PENDING_EDIT_INPUT_MAX_BYTES : PENDING_INPUT_MAX_BYTES;
  const copy: unknown = JSON.parse(json);
  if (byteLength(json) <= max) return { input: copy, truncated: false };
  for (let limit = Math.floor(max / 2); limit >= 64; limit = Math.floor(limit / 2)) {
    const cut = cutStrings(copy, limit);
    if (byteLength(JSON.stringify(cut)) <= max) return { input: cut, truncated: true };
  }
  let preview = json.slice(0, max);
  while (preview.length > 0 && byteLength(JSON.stringify({ preview: preview + INPUT_TRUNCATION_MARKER })) > max) {
    preview = preview.slice(0, Math.floor(preview.length * 0.8));
  }
  return { input: { preview: preview + INPUT_TRUNCATION_MARKER }, truncated: true };
}

/** AskUserQuestion's questions: `{ questions: [...] }`, or the older single `{ question, options }`. */
function questionsOf(input: unknown): unknown[] {
  if (!input || typeof input !== 'object') return [];
  const { questions, question, options } = input as Record<string, unknown>;
  if (Array.isArray(questions)) return questions;
  return typeof question === 'string' && Array.isArray(options) ? [input] : [];
}

function optionOf(raw: unknown): PendingRequestOption | null {
  const option = typeof raw === 'string' ? { label: raw } : raw;
  if (!option || typeof option !== 'object') return null;
  const { label, description } = option as Record<string, unknown>;
  if (typeof label !== 'string' || label === '') return null;
  return {
    label: label.slice(0, MAX_LABEL_CHARS),
    ...(typeof description === 'string' && description !== '' ? { description: description.slice(0, MAX_DESCRIPTION_CHARS) } : {}),
  };
}

/**
 * The choices a card may offer for an AskUserQuestion: only a single, single-select
 * question with 1–9 choices, which one digit key answers. Anything else is undefined
 * (the card shows the input and sends the user to the terminal).
 */
export function answerableOptions(input: unknown): PendingRequestOption[] | undefined {
  const questions = questionsOf(input);
  if (questions.length !== 1 || !questions[0] || typeof questions[0] !== 'object') return undefined;
  const { multiSelect, options } = questions[0] as Record<string, unknown>;
  if (multiSelect === true || !Array.isArray(options)) return undefined;
  if (options.length < 1 || options.length > MAX_ANSWERABLE_OPTIONS) return undefined;
  const parsed = options.map(optionOf);
  return parsed.every((option): option is PendingRequestOption => option !== null) ? parsed : undefined;
}

function raisedRequest(hook: Record<string, unknown>, source: Source, cli: Cli, now: number, ambiguous: boolean): PendingRequest {
  const tool = saneString(hook.tool_name, MAX_ID_CHARS) ?? 'Unknown';
  const toolUseId = saneString(hook.tool_use_id, MAX_ID_CHARS);
  const kind = requestKindOf(tool);
  const { input, truncated } = capRequestInput(tool, hook.tool_input);
  const options = kind === 'question' ? answerableOptions(hook.tool_input) : undefined;
  // A call the CLI can't save as a rule comes with no suggestions, and then Claude's
  // option 2 is "switch to auto mode", not "always allow" (probed on 2.1.300).
  const suggestions = hook.permission_suggestions;
  const canAlwaysAllow = source === 'permission_request' && Array.isArray(suggestions) && suggestions.length > 0;
  const request: PendingRequest = {
    id: toolUseId ?? randomUUID(),
    ...(toolUseId ? { toolUseId } : {}),
    kind,
    cli,
    tool,
    ...(input !== undefined ? { input } : {}),
    ...(truncated ? { inputTruncated: true } : {}),
    ...(options ? { options } : {}),
    ...(canAlwaysAllow ? { canAlwaysAllow: true } : {}),
    ...(ambiguous ? { ambiguous: true } : {}),
    raisedAt: now,
    source,
  };
  if (input !== undefined) inputKeys.set(request, createHash('sha256').update(JSON.stringify(hook.tool_input)).digest('hex'));
  return request;
}

const isGuess = (request: PendingRequest): boolean => request.source === 'timer' || request.source === 'notification';

/**
 * Are two raised requests the same call? The call ids decide when both have one;
 * otherwise only the same tool with the same input is. (Two Bash calls asked one after
 * the other must never share an id, or a card would show the first command while the
 * CLI asks about the second.)
 */
function sameCall(a: PendingRequest, b: PendingRequest): boolean {
  if (a.tool !== b.tool || a.kind !== b.kind) return false;
  if (a.toolUseId && b.toolUseId) return a.toolUseId === b.toolUseId;
  const key = inputKeys.get(a);
  return key !== undefined && key === inputKeys.get(b);
}

/** Does this PostToolUse / PostToolUseFailure end the call `current` waits on? */
function endsCall(current: PendingRequest, hook: Record<string, unknown>): boolean {
  const toolUseId = saneString(hook.tool_use_id, MAX_ID_CHARS);
  if (current.toolUseId && toolUseId) return current.toolUseId === toolUseId;
  const tool = saneString(hook.tool_name, MAX_ID_CHARS);
  return !tool || tool === current.tool;
}

/**
 * The session's pending request after a hook event. Returns `current` itself when the
 * event changes nothing, so the caller can tell. `cli` null (a CLI whose dialogs AASC
 * doesn't know) raises nothing; clearing still applies.
 */
export function nextPendingRequest(
  current: PendingRequest | null,
  event: string,
  hook: Record<string, unknown>,
  cli: Cli | null,
  now: number,
): PendingRequest | null {
  if (CLEARING_EVENTS.has(event)) return null;
  if (CALL_ENDS.has(event)) return current && endsCall(current, hook) ? null : current;
  if (!cli) return current;
  const tool = saneString(hook.tool_name, MAX_ID_CHARS);
  const asking = event === 'PermissionRequest' || (event === 'PreToolUse' && tool !== undefined && ASKING_TOOLS.has(tool));
  if (!asking) return current;
  const open = current !== null && !isGuess(current);
  const raised = raisedRequest(hook, event === 'PermissionRequest' ? 'permission_request' : 'pre_tool_use', cli, now, open);
  // The PermissionRequest of a question already raised by its PreToolUse (or the other
  // way round) is the same request: keep its id, a card may be showing it. A different
  // request while one is still open means parallel calls: the CLI queues their dialogs
  // and may be showing the older one, so the newer one is kept but marked ambiguous.
  return open && sameCall(current, raised) ? current : raised;
}

/**
 * A wait the timer or a permission_prompt Notification guessed: the tool, no input.
 * Never replaces a request already there.
 */
export function guessPendingRequest(
  current: PendingRequest | null,
  tool: string,
  source: 'timer' | 'notification',
  cli: Cli | null,
  now: number,
): PendingRequest | null {
  if (current || !cli) return current;
  return { id: randomUUID(), kind: requestKindOf(tool), cli, tool, raisedAt: now, source };
}
