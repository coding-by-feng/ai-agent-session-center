/**
 * promptApi.ts — the phone composer's prompt to the Mac (AASC-42).
 *
 * The phone sends intent, not keystrokes: `POST /api/sessions/:id/prompt` with
 * the text, the ids of photos it uploaded first (`POST /api/queue-images`), the
 * mode (`now`, or `interrupt`: stop the turn first) and a request key. The Mac
 * types it, presses Enter, and presses it again until the CLI acknowledges the
 * prompt (server/promptSubmit.ts), so a phone that locks right after sending
 * never leaves a prompt typed but unsent. The phone then asks
 * `GET …/prompt/:key` what became of it, about once a second.
 *
 * The key makes a retry safe: the same key and prompt twice sends once. Every
 * refusal comes back as a code and a sentence a person can act on.
 * The client-id header rides on every same-origin fetch (presenceClient).
 */
import type { QueueImageAttachment } from '@/stores/queueStore';

export type PromptMode = 'now' | 'interrupt';

/** Where a prompt is on the Mac (server/promptRouter.ts). */
export type PromptState = 'pending' | 'submitted' | 'unconfirmed' | 'stopped' | 'gave-up' | 'failed';

/** How waiting for a prompt ended: the Mac's word, or why the phone stopped asking. */
export type PromptWaitResult = Exclude<PromptState, 'pending'> | 'timeout' | 'unknown' | 'aborted';

export type PromptErrorCode =
  | 'needs_argument'
  | 'image_not_found'
  | 'invalid'
  | 'not_found'
  | 'agent_not_running'
  | 'agent_not_ready'
  | 'awaiting_answer'
  | 'key_reused'
  | 'busy'
  | 'control_held'
  | 'rate_limited'
  | 'network'
  | 'failed';

export interface PromptDriver {
  label: string;
  online: boolean;
}

export interface PromptError {
  code: PromptErrorCode;
  message: string;
  /** control_held: who drives the session (null when nobody is named). */
  driver?: PromptDriver | null;
  /** rate_limited: seconds to wait. */
  retryAfter?: number;
}

export type PromptPostResult = { ok: true; key: string } | { ok: false; error: PromptError };

export interface PromptBody {
  text: string;
  images?: string[];
  mode: PromptMode;
  key: string;
}

/** Poll the prompt's state this often… */
export const PROMPT_POLL_INTERVAL_MS = 1_000;
/** …for at most this long: the Mac's own retries end within about 75 s. */
export const PROMPT_POLL_TIMEOUT_MS = 90_000;
/** Photos per prompt, as the route allows. */
export const MAX_PROMPT_IMAGES = 4;

const NETWORK_MESSAGE = 'Couldn’t reach your Mac. Check the connection and try again.';

/** A fresh request key: what names this prompt for a retry and for its status. */
export function newPromptKey(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 14).padEnd(12, '0');
  return `phone-${Date.now().toString(36)}-${random}`;
}

interface ErrorReply {
  error?: unknown;
  code?: unknown;
  driver?: unknown;
  retryAfter?: unknown;
}

function readDriver(value: unknown): PromptDriver | null {
  if (!value || typeof value !== 'object') return null;
  const { label, online } = value as Record<string, unknown>;
  return typeof label === 'string' ? { label, online: online === true } : null;
}

/** A refusal from the prompt route, in plain words. */
export function promptErrorFor(status: number, reply: ErrorReply | null): PromptError {
  const code = typeof reply?.code === 'string' ? reply.code : '';
  if (status === 400 && code === 'needs_argument') {
    return { code: 'needs_argument', message: 'This command opens a menu. Pick its choice first, like /model sonnet.' };
  }
  if (status === 400 && code === 'image_not_found') {
    return { code: 'image_not_found', message: 'A photo is no longer on your Mac. Attach it again.' };
  }
  if (status === 400) return { code: 'invalid', message: 'Your Mac couldn’t read that message. Check it and try again.' };
  if (status === 404) return { code: 'not_found', message: 'This session ended, or it isn’t shared with this phone any more.' };
  if (status === 409) {
    switch (code) {
      case 'AGENT_NOT_RUNNING':
        return { code: 'agent_not_running', message: 'The agent isn’t running in this session’s terminal.' };
      case 'agent_not_ready':
        return { code: 'agent_not_ready', message: 'The agent is still starting. Try again in a moment.' };
      case 'awaiting_answer':
        return { code: 'awaiting_answer', message: 'The agent is waiting for an answer. Answer it first.' };
      case 'key_reused':
        return { code: 'key_reused', message: 'That message clashed with another one. Send it again.' };
      case 'busy':
        return { code: 'busy', message: 'Another message is still being typed into this session. Try again in a moment.' };
      default:
        return { code: 'failed', message: 'Your Mac couldn’t send that right now. Try again.' };
    }
  }
  if (status === 423) {
    const driver = readDriver(reply?.driver);
    return {
      code: 'control_held',
      message: `${driver?.label ?? 'Another device'} is driving this session. Take control to send.`,
      driver,
    };
  }
  if (status === 429) {
    const retryAfter = typeof reply?.retryAfter === 'number' && reply.retryAfter > 0 ? Math.ceil(reply.retryAfter) : undefined;
    return {
      code: 'rate_limited',
      message: retryAfter ? `Too many messages from this phone. Try again in ${retryAfter} s.` : 'Too many messages from this phone. Wait a moment.',
      retryAfter,
    };
  }
  return { code: 'failed', message: 'Your Mac couldn’t send that right now. Try again.' };
}

/** One POST to the prompt route. Never throws. */
export async function postPrompt(sessionId: string, body: PromptBody): Promise<PromptPostResult> {
  const payload: PromptBody = { text: body.text, mode: body.mode, key: body.key };
  if (body.images && body.images.length > 0) payload.images = body.images;
  let res: Response;
  try {
    res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, error: { code: 'network', message: NETWORK_MESSAGE } };
  }
  const reply = (await res.json().catch(() => null)) as (ErrorReply & { data?: { key?: unknown } }) | null;
  if (res.status === 202 || res.ok) {
    const key = typeof reply?.data?.key === 'string' ? reply.data.key : body.key;
    return { ok: true, key };
  }
  return { ok: false, error: promptErrorFor(res.status, reply) };
}

/** Upload the composer's photos as queue images; their ids go in the prompt. Never throws. */
export async function uploadPromptImages(
  images: readonly QueueImageAttachment[],
): Promise<{ ok: true; ids: string[] } | { ok: false; error: PromptError }> {
  if (images.length === 0) return { ok: true, ids: [] };
  let res: Response;
  try {
    res = await fetch('/api/queue-images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images: images.map(({ name, dataUrl }) => ({ name, dataUrl })) }),
    });
  } catch {
    return { ok: false, error: { code: 'network', message: NETWORK_MESSAGE } };
  }
  const reply = (await res.json().catch(() => null)) as { ids?: unknown } | null;
  const ids = Array.isArray(reply?.ids) ? reply.ids.filter((id): id is string => typeof id === 'string') : [];
  if (!res.ok || ids.length !== images.length) {
    return { ok: false, error: { code: 'failed', message: 'Your Mac couldn’t take the photos. Try again, or send fewer.' } };
  }
  return { ok: true, ids };
}

export interface SendPromptInput {
  text: string;
  images?: readonly QueueImageAttachment[];
  mode: PromptMode;
}

/**
 * Upload the photos, then post the prompt. One retry each for what a retry can
 * fix: a dropped connection (same key, so the Mac sends it once), a clashing
 * key (a new one), and photos the Mac had already swept (uploaded again).
 */
export async function sendPrompt(sessionId: string, input: SendPromptInput): Promise<PromptPostResult> {
  const images = input.images ?? [];
  let upload = await uploadPromptImages(images);
  if (!upload.ok) return upload;
  let key = newPromptKey();
  const post = () => postPrompt(sessionId, { text: input.text, images: upload.ok ? upload.ids : [], mode: input.mode, key });
  let result = await post();
  if (!result.ok && result.error.code === 'network') result = await post();
  if (!result.ok && result.error.code === 'key_reused') {
    key = newPromptKey();
    result = await post();
  }
  if (!result.ok && result.error.code === 'image_not_found' && images.length > 0) {
    upload = await uploadPromptImages(images);
    if (!upload.ok) return upload;
    key = newPromptKey();
    result = await post();
  }
  return result;
}

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface WaitOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** The prompt's state, null for an unknown key, undefined when the Mac couldn't be asked. */
async function readPromptState(sessionId: string, key: string): Promise<PromptState | null | undefined> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt/${encodeURIComponent(key)}`);
    if (res.status === 404) return null;
    if (!res.ok) return undefined;
    const reply = (await res.json().catch(() => null)) as { data?: { state?: unknown } } | null;
    const state = reply?.data?.state;
    return typeof state === 'string' ? (state as PromptState) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the Mac what became of a prompt until it says (submitted, sent once, or
 * why not), the key is unknown (the Mac restarted), `timeoutMs` passes, or the
 * signal aborts. A request that fails just waits for the next round.
 */
export async function waitForPrompt(sessionId: string, key: string, opts: WaitOptions = {}): Promise<PromptWaitResult> {
  const intervalMs = opts.intervalMs ?? PROMPT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? PROMPT_POLL_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepFor;
  const start = now();
  for (;;) {
    if (opts.signal?.aborted) return 'aborted';
    const state = await readPromptState(sessionId, key);
    if (state === null) return 'unknown';
    if (state && state !== 'pending') return state;
    if (now() - start >= timeoutMs) return 'timeout';
    await sleep(intervalMs);
  }
}

/** What to tell the person once the wait is over. */
export function promptOutcome(result: PromptWaitResult): { ok: boolean; message: string } {
  switch (result) {
    case 'submitted':
      return { ok: true, message: 'Sent' };
    case 'unconfirmed':
      return { ok: true, message: 'Sent' };
    case 'stopped':
      return { ok: false, message: 'Not sent: the session changed before it could be typed (a question, a stop, or another device).' };
    case 'gave-up':
      return { ok: false, message: 'Typed, but the agent never took it. Check the terminal.' };
    case 'failed':
      return { ok: false, message: 'Not sent: the session’s terminal is gone.' };
    case 'timeout':
      return { ok: false, message: 'No word from your Mac about that message. Check the terminal.' };
    case 'unknown':
      return { ok: false, message: 'Your Mac lost track of that message (did AASC restart?). Check the terminal.' };
    case 'aborted':
      return { ok: false, message: 'Stopped waiting for that message.' };
    default:
      return { ok: false, message: 'Not sent.' };
  }
}
