// dictation.ts — speech to text for the phone app's hold-to-talk 🎙 (Nov 16 2026).
//
// The app records a short clip while the button is held (DictationBridge on iOS and Android) and the Mac's page posts
// it to `POST /api/voice/dictate`. This module sends that clip to OpenAI's transcription API with this Mac's own
// project key (voice.json, the same key as voice calls) and answers the text. The page puts the text in the box;
// nothing is sent to an agent here, and neither the audio nor the text is logged or kept.
//
// Shapes are from developers.openai.com/api/docs/guides/speech-to-text (read Nov 16 2026): a multipart `file` +
// `model`, `{ "text": "…" }` back; m4a, webm, wav, ogg and mp3 are accepted, up to 25 MB.

import { failureOf, LiveApiError, upstreamMessage } from './liveApi.js';

export const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
export const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';

/** How long OpenAI may take over one clip before it is given up. */
export const TRANSCRIBE_TIMEOUT_MS = 30_000;

/** The longest text handed back: two minutes of speech is far below it. */
export const TEXT_MAX = 8_000;

/** The clip types the apps record, and the file name OpenAI reads the format from. */
const FILE_NAMES: Readonly<Record<string, string>> = {
  'audio/mp4': 'dictation.m4a',
  'audio/m4a': 'dictation.m4a',
  'audio/x-m4a': 'dictation.m4a',
  'audio/webm': 'dictation.webm',
  'audio/wav': 'dictation.wav',
  'audio/ogg': 'dictation.ogg',
  'audio/mpeg': 'dictation.mp3',
};

export const DICTATION_MIME_TYPES = Object.keys(FILE_NAMES) as readonly string[];

/** The upload's file name for a clip of this type, or null for a type no app records. */
export function audioFileName(mime: string): string | null {
  return Object.hasOwn(FILE_NAMES, mime) ? FILE_NAMES[mime] : null;
}

export interface TranscribeInput {
  apiKey: string;
  audio: Buffer;
  mime: string;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Text for an input box: no control characters but new lines and tabs, trimmed, at most TEXT_MAX. */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, TEXT_MAX);
}

/** The clip's words ('' when nothing was heard). Throws LiveApiError, with the key taken out of its message. */
export async function transcribeAudio(input: TranscribeInput, fetchImpl: FetchLike = fetch): Promise<string> {
  const name = audioFileName(input.mime);
  if (!name) throw new LiveApiError('bad_request', 0, 'Not a clip type the apps record');
  const form = new FormData();
  form.append('file', new File([new Uint8Array(input.audio)], name, { type: input.mime }));
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'json');
  let res: Response;
  try {
    res = await fetchImpl(TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LiveApiError('network', 0, `Could not reach OpenAI: ${message.split(input.apiKey).join('***')}`);
  }
  if (!res.ok) {
    throw new LiveApiError(failureOf(res.status), res.status, await upstreamMessage(res, input.apiKey));
  }
  const data = (await res.json().catch(() => null)) as { text?: unknown } | null;
  if (typeof data?.text !== 'string') {
    throw new LiveApiError('upstream', res.status, 'OpenAI answered without text');
  }
  return clean(data.text);
}
