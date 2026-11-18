/**
 * phoneDictation — the phone app's hold-to-talk 🎙 (Nov 16 2026): speak, and the words land in the box.
 *
 * The Mac's page is plain http inside the app, so it has no microphone, and it can't call the app's plugins.
 * So the app records and this page does the rest:
 *   1. The page asks the app to `start` / `stop` / `cancel` one recording, by id:
 *        iOS      `window.webkit.messageHandlers.aascDictation.postMessage({ id, action })` (DictationBridge.swift)
 *        Android  `window.aascDictation.postMessage('{"id":…,"action":…}')`, a WebMessageListener (DictationBridge.kt)
 *   2. The app answers: on iOS with an `aasc-dictation` window event, on Android with a `message` on that same
 *      object. On `stop` it hands over the clip (base64 AAC in an .m4a, at most two minutes).
 *   3. The page posts the clip to this Mac (`POST /api/voice/dictate`), which turns it into text with the
 *      OpenAI key saved for voice calls, and the text is put in the input box. Nothing is ever sent for you.
 * An app from before this build has neither object: `dictationBridge()` is null and no button shows.
 */

export const DICTATION_HANDLER = 'aascDictation';
export const DICTATION_EVENT = 'aasc-dictation';
export const DICTATE_URL = '/api/voice/dictate';

/** How long the Mac may take over one clip (its own wait on OpenAI is 30 s). */
export const TRANSCRIPT_TIMEOUT_MS = 45_000;

export type DictationAction = 'start' | 'stop' | 'cancel';

/** What the app says about one recording. */
export type DictationOutcome =
  | { id: string; state: 'recording' }
  /** The phone asked for the microphone instead of recording; `granted` is its answer. */
  | { id: string; state: 'permission'; granted: boolean }
  | { id: string; state: 'audio'; audio: string; mime: string; ms: number }
  /** Nothing kept. `short`: let go too soon to hold speech. */
  | { id: string; state: 'cancelled'; short: boolean }
  | { id: string; state: 'failed'; message?: string };

export interface DictationBridge {
  post(id: string, action: DictationAction): void;
  /** Hear the app's answers; returns the stop. */
  listen(listener: (outcome: DictationOutcome) => void): () => void;
}

/** Reads one answer from the app; null for anything malformed. */
export function readDictationOutcome(detail: unknown): DictationOutcome | null {
  if (!detail || typeof detail !== 'object') return null;
  const { id, state, granted, audio, mime, ms, short, message } = detail as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return null;
  switch (state) {
    case 'recording':
      return { id, state };
    case 'permission':
      return typeof granted === 'boolean' ? { id, state, granted } : null;
    case 'audio':
      if (typeof audio !== 'string' || !audio || typeof mime !== 'string' || !mime) return null;
      return { id, state, audio, mime, ms: typeof ms === 'number' && Number.isFinite(ms) ? ms : 0 };
    case 'cancelled':
      return { id, state, short: short === true };
    case 'failed':
      return { id, state, ...(typeof message === 'string' && message ? { message: message.slice(0, 200) } : {}) };
    default:
      return null;
  }
}

interface IosHandler {
  postMessage(body: unknown): void;
}

interface AndroidPort {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: (event: Event) => void): void;
  removeEventListener(type: 'message', listener: (event: Event) => void): void;
}

type AppWindow = Window & {
  webkit?: { messageHandlers?: Record<string, IosHandler | undefined> };
  aascDictation?: Partial<AndroidPort>;
};

/** The app's recorder, or null where there is none (a browser, a desktop, an app from before this build). */
export function dictationBridge(win: Window | undefined = typeof window === 'undefined' ? undefined : window): DictationBridge | null {
  if (!win) return null;
  const w = win as AppWindow;
  const ios = w.webkit?.messageHandlers?.[DICTATION_HANDLER];
  if (ios && typeof ios.postMessage === 'function') {
    return {
      post: (id, action) => ios.postMessage({ id, action }),
      listen: (listener) => {
        const onEvent = (event: Event) => {
          const outcome = readDictationOutcome((event as CustomEvent<unknown>).detail);
          if (outcome) listener(outcome);
        };
        win.addEventListener(DICTATION_EVENT, onEvent);
        return () => win.removeEventListener(DICTATION_EVENT, onEvent);
      },
    };
  }
  const port = w[DICTATION_HANDLER];
  if (port && typeof port.postMessage === 'function' && typeof port.addEventListener === 'function' && typeof port.removeEventListener === 'function') {
    const android = port as AndroidPort;
    return {
      post: (id, action) => android.postMessage(JSON.stringify({ id, action })),
      listen: (listener) => {
        const onMessage = (event: Event) => {
          const data = (event as MessageEvent<unknown>).data;
          if (typeof data !== 'string') return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          const outcome = readDictationOutcome(parsed);
          if (outcome) listener(outcome);
        };
        android.addEventListener('message', onMessage);
        return () => android.removeEventListener('message', onMessage);
      },
    };
  }
  return null;
}

export type TranscriptResult = { ok: true; text: string } | { ok: false; code: string; message: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Ask this Mac for the clip's words. A refusal carries the Mac's own sentence. */
export async function requestTranscript(
  audio: string,
  mime: string,
  fetchFn: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<TranscriptResult> {
  // A hand-made timeout: iOS 15's WebView has neither AbortSignal.timeout nor AbortSignal.any.
  const gate = new AbortController();
  const timer = setTimeout(() => gate.abort(), TRANSCRIPT_TIMEOUT_MS);
  const onAbort = () => gate.abort();
  if (signal?.aborted) gate.abort();
  signal?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetchFn(DICTATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio, mime }),
      signal: gate.signal,
    });
  } catch {
    return { ok: false, code: 'offline', message: 'Couldn’t reach the Mac. Check the connection and try again.' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; code?: unknown; error?: unknown; data?: { text?: unknown } }
    | null;
  if (res.ok && body?.success === true && typeof body.data?.text === 'string') {
    return { ok: true, text: body.data.text };
  }
  if (body && typeof body.error === 'string' && body.error) {
    return { ok: false, code: typeof body.code === 'string' ? body.code : 'failed', message: body.error.slice(0, 200) };
  }
  if (res.status === 404) {
    return { ok: false, code: 'unsupported', message: 'This Mac’s AASC can’t dictate yet. Update AASC on the Mac.' };
  }
  return { ok: false, code: 'failed', message: 'The recording couldn’t be turned into text. Try again.' };
}

const CJK = /[⺀-鿿豈-﫿＀-￯]/;
const OPENERS = '([{“‘"\'';
const CLOSERS = '.,!?;:)]}”’…';

/** Is a space wanted between `before` and `after` (two single characters, either may be empty)? */
function wantsSpace(before: string, after: string): boolean {
  if (!before || !after || /\s/.test(before) || /\s/.test(after)) return false;
  if (CJK.test(before) || CJK.test(after)) return false;
  return !OPENERS.includes(before) && !CLOSERS.includes(after);
}

/**
 * The box's text with the spoken words put in at `caret` (null or past the end: appended), and where the
 * caret goes next. A space is added on a side only where two words would otherwise touch.
 */
export function insertDictation(current: string, caret: number | null, spoken: string): { text: string; caret: number } {
  const at = caret === null || caret > current.length || caret < 0 ? current.length : caret;
  const head = current.slice(0, at);
  const tail = current.slice(at);
  const lead = wantsSpace(head.slice(-1), spoken.slice(0, 1)) ? ' ' : '';
  const trail = wantsSpace(spoken.slice(-1), tail.slice(0, 1)) ? ' ' : '';
  const inserted = lead + spoken + trail;
  return { text: head + inserted + tail, caret: head.length + inserted.length };
}
