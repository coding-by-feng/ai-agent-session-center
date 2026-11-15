// liveApi.ts — the two calls AASC makes to OpenAI's GPT-Live API for a voice call.
//
//   createLiveSession  POST /v1/live/sessions with the phone's WebRTC SDP offer, as this Mac's project key. The phone
//                      gets the SDP answer and talks to OpenAI directly; it never holds a key or a client secret.
//   attachSideband     wss://…/v1/live/sessions/{id}/attach: AASC's own control channel to that same call. It hears
//                      the transcript and the delegations, and sends the status digest and the Voice central's
//                      answers. On attach OpenAI replays the last 3 s of events with their original `event_id`, so
//                      events are passed on once per id.
//
// Shapes are from developers.openai.com/api/docs/guides/{realtime-webrtc,voice-server-controls,live-delegation}
// (read Nov 15 2026). Delegation is `client`: the voice does no backend work itself (see voiceText.ts).

import log from '../logger.js';

export const LIVE_MODEL = 'gpt-live-1';
export const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';
const ATTACH_URL = (sessionId: string): string => `wss://api.openai.com/v1/live/sessions/${sessionId}/attach`;

/** How long the voice waits before its automatic "let me check" (the API's maximum is 800 ms). */
export const ACK_DELAY_MS = 800;

/** How long session creation may take before it is given up. */
export const CREATE_TIMEOUT_MS = 15_000;

/** Replayed events are recognised by id; this many recent ids are kept. */
const SEEN_IDS_MAX = 500;

/** A session id as OpenAI returns them (`live_…`): used in a URL, so nothing else is accepted. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type LiveFailure = 'key' | 'access' | 'rate' | 'bad_request' | 'upstream' | 'network';

export class LiveApiError extends Error {
  constructor(readonly reason: LiveFailure, readonly status: number, message: string) {
    super(message);
    this.name = 'LiveApiError';
  }
}

export interface CreateLiveInput {
  apiKey: string;
  sdp: string;
  instructions: string;
  voice: string;
}

export interface LiveSessionCreated {
  sessionId: string;
  sdp: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function failureOf(status: number): LiveFailure {
  if (status === 401) return 'key';
  if (status === 403) return 'access';
  if (status === 429) return 'rate';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'upstream';
}

/** OpenAI's own error message, short and with the key taken out. */
async function upstreamMessage(res: Response, apiKey: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: unknown } };
    const message = typeof body.error?.message === 'string' ? body.error.message : `HTTP ${res.status}`;
    return message.split(apiKey).join('***').slice(0, 300);
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function createLiveSession(input: CreateLiveInput, fetchImpl: FetchLike = fetch): Promise<LiveSessionCreated> {
  const body = {
    session: {
      model: LIVE_MODEL,
      instructions: input.instructions,
      delegation: { type: 'client', acknowledgement_delay_ms: ACK_DELAY_MS },
      audio: { output: { voice: input.voice } },
    },
    transport: { type: 'webrtc', sdp: input.sdp },
  };
  let res: Response;
  try {
    res = await fetchImpl(LIVE_SESSIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new LiveApiError('network', 0, `Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new LiveApiError(failureOf(res.status), res.status, await upstreamMessage(res, input.apiKey));
  }
  const data = (await res.json().catch(() => null)) as { session?: { id?: unknown }; transport?: { sdp?: unknown } } | null;
  const sessionId = data?.session?.id;
  const sdp = data?.transport?.sdp;
  if (typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId) || typeof sdp !== 'string' || !sdp) {
    throw new LiveApiError('upstream', res.status, 'OpenAI answered without a session id or SDP answer');
  }
  return { sessionId, sdp };
}

// ---------------------------------------------------------------------------
// The sideband
// ---------------------------------------------------------------------------

/** One GPT-Live event, sent or received. */
export type LiveEvent = { type: string; [key: string]: unknown };

/** The part of a `ws` WebSocket the sideband uses (tests pass a fake). */
export interface SidebandSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: Buffer | string) => void): unknown;
  on(event: 'close', listener: (code: number) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type SidebandConnect = (url: string, headers: Record<string, string>) => SidebandSocketLike;

export interface Sideband {
  /** Settles when the socket opens; rejects when it closes first. */
  readonly ready: Promise<void>;
  /** Sends now, or once the socket opens. Dropped after close. */
  send(event: LiveEvent): void;
  onEvent(listener: (event: LiveEvent) => void): () => void;
  /** Told once, when the socket closes for any reason. */
  onClose(listener: () => void): () => void;
  close(): void;
}

const OPEN = 1;

export function attachSideband(opts: { apiKey: string; sessionId: string; connect: SidebandConnect }): Sideband {
  if (!SESSION_ID_RE.test(opts.sessionId)) throw new LiveApiError('bad_request', 0, 'Not a GPT-Live session id');
  const socket = opts.connect(ATTACH_URL(opts.sessionId), { Authorization: `Bearer ${opts.apiKey}` });
  const events = new Set<(e: LiveEvent) => void>();
  const closes = new Set<() => void>();
  const seen = new Set<string>();
  let pending: string[] = [];
  let closed = false;

  let settle: (ok: boolean, err?: Error) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    settle = (ok, err) => (ok ? resolve() : reject(err ?? new Error('The sideband closed before it opened')));
  });
  ready.catch(() => {}); // a caller that never awaits it must not see an unhandled rejection

  socket.on('open', () => {
    settle(true);
    for (const data of pending) socket.send(data);
    pending = [];
  });

  socket.on('message', (data) => {
    let event: unknown;
    try {
      event = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'));
    } catch {
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof (event as LiveEvent).type !== 'string') return;
    const id = (event as LiveEvent).event_id;
    if (typeof id === 'string') {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > SEEN_IDS_MAX) seen.delete(seen.values().next().value as string);
    }
    for (const l of [...events]) {
      try {
        l(event as LiveEvent);
      } catch (err) {
        log.error('voice', `Sideband listener failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  socket.on('error', (err) => {
    log.warn('voice', `Sideband error: ${err.message}`);
    settle(false, err);
  });

  socket.on('close', () => {
    if (closed) return;
    closed = true;
    pending = [];
    settle(false);
    for (const l of [...closes]) l();
  });

  return {
    ready,
    send(event) {
      if (closed) return;
      const data = JSON.stringify(event);
      if (socket.readyState === OPEN) socket.send(data);
      else pending.push(data);
    },
    onEvent(listener) {
      events.add(listener);
      return () => events.delete(listener);
    },
    onClose(listener) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      if (!closed) socket.close();
    },
  };
}
