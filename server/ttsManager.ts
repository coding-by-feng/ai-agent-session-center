/**
 * ttsManager — Google Cloud Text-to-Speech REST client.
 *
 * Auth model: per-user API key provided by the caller on every request.
 * No ambient credentials. No service account file. No gcloud / ADC.
 *
 * This keeps credentials scoped per user of the dashboard — each person pastes
 * their own API key (restricted to Text-to-Speech API in their own GCP project)
 * into Settings → Voice, and the backend never has an implicit identity.
 *
 * Bilingual: auto-picks EN vs zh-CN voice based on CJK character detection so a
 * single request spanning both languages is split into sequential synth calls.
 */
import log from './logger.js';

const TTS_ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
const MAX_CHARS_PER_REQUEST = 4500; // API hard limit is 5000 bytes
const MAX_CONCURRENT = 3;

// Voices: Chirp 3 HD is the most natural. Callers can override.
export const DEFAULT_VOICE_EN = 'en-US-Chirp3-HD-Aoede';
export const DEFAULT_VOICE_ZH = 'cmn-CN-Chirp3-HD-Aoede';

/** Split text into segments tagged with language ("en" or "zh"). */
export function splitByLanguage(text: string): Array<{ lang: 'en' | 'zh'; text: string }> {
  if (!text) return [];
  const segments: Array<{ lang: 'en' | 'zh'; text: string }> = [];
  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/;
  let currentLang: 'en' | 'zh' = CJK_RE.test(text[0]) ? 'zh' : 'en';
  let buf = '';
  for (const ch of text) {
    const isCjk = CJK_RE.test(ch);
    const lang: 'en' | 'zh' = isCjk ? 'zh' : 'en';
    // Whitespace and punctuation stick to the current run to avoid over-splitting
    if (/[\s.,;:!?'"`\-—/\\()[\]{}<>@#$%^&*+=|~]/.test(ch)) {
      buf += ch;
      continue;
    }
    if (lang !== currentLang && buf.trim().length > 0) {
      segments.push({ lang: currentLang, text: buf });
      buf = '';
    }
    currentLang = lang;
    buf += ch;
  }
  if (buf.trim().length > 0) segments.push({ lang: currentLang, text: buf });
  return segments;
}

/** Further split a long segment at sentence/word boundaries under the char limit. */
function chunkSegment(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf('. ', maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf('。', maxChars);
    if (cut < maxChars * 0.5) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut <= 0) cut = maxChars;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) out.push(remaining);
  return out;
}

export interface SynthesizeOptions {
  /** Per-user Google Cloud API key with Text-to-Speech API enabled. Required. */
  apiKey: string;
  text: string;
  voiceEn?: string;
  voiceZh?: string;
  speakingRate?: number; // 0.25 .. 4.0
  /** Explicitly pick language; when omitted, auto-detect per segment. */
  lang?: 'en' | 'zh' | 'auto';
}

let activeRequests = 0;

async function callSynth(
  apiKey: string,
  textChunk: string,
  voiceName: string,
  languageCode: string,
  speakingRate: number,
): Promise<Buffer> {
  const body = {
    input: { text: textChunk },
    voice: { languageCode, name: voiceName },
    audioConfig: {
      audioEncoding: 'MP3',
      speakingRate,
      effectsProfileId: ['headphone-class-device'],
    },
  };
  const url = `${TTS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    // Strip the key if it ever appears in an error payload (defense in depth)
    const safeText = errText.replace(apiKey, '***').slice(0, 300);
    throw new Error(`TTS API ${res.status}: ${safeText}`);
  }
  const json = await res.json() as { audioContent?: string };
  if (!json.audioContent) throw new Error('TTS response missing audioContent');
  return Buffer.from(json.audioContent, 'base64');
}

/**
 * Synthesize bilingual text → single MP3 buffer (concatenated segments).
 * MP3 frames are self-synchronising, so naive concatenation plays correctly.
 */
export async function synthesize(opts: SynthesizeOptions): Promise<Buffer> {
  const apiKey = (opts.apiKey || '').trim();
  if (!apiKey) throw new Error('Google TTS API key not configured');
  const text = (opts.text || '').trim();
  if (!text) throw new Error('Empty text');
  if (activeRequests >= MAX_CONCURRENT) {
    throw new Error('TTS busy — too many concurrent requests');
  }
  activeRequests++;
  try {
    const voiceEn = opts.voiceEn || DEFAULT_VOICE_EN;
    const voiceZh = opts.voiceZh || DEFAULT_VOICE_ZH;
    const rate = opts.speakingRate ?? 1.0;

    const rawSegments =
      opts.lang === 'en' ? [{ lang: 'en' as const, text }]
      : opts.lang === 'zh' ? [{ lang: 'zh' as const, text }]
      : splitByLanguage(text);

    const buffers: Buffer[] = [];
    for (const seg of rawSegments) {
      const voice = seg.lang === 'zh' ? voiceZh : voiceEn;
      const langCode = seg.lang === 'zh' ? 'cmn-CN' : 'en-US';
      for (const chunk of chunkSegment(seg.text, MAX_CHARS_PER_REQUEST)) {
        if (!chunk.trim()) continue;
        buffers.push(await callSynth(apiKey, chunk, voice, langCode, rate));
      }
    }
    return Buffer.concat(buffers);
  } catch (err) {
    // Never log the API key in error paths
    const msg = err instanceof Error ? err.message : String(err);
    log.error('tts-manager', `synthesize failed: ${msg.replace(apiKey, '***')}`);
    throw err;
  } finally {
    activeRequests--;
  }
}

/**
 * Probe the provided API key with a minimal voices.list call.
 * Returns { ok: true } if the key is valid; { ok: false, error } otherwise.
 */
export async function checkApiKey(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const key = (apiKey || '').trim();
  if (!key) return { ok: false, error: 'No API key provided' };
  try {
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/voices?key=${encodeURIComponent(key)}&languageCode=en-US`,
      { method: 'GET' },
    );
    if (!res.ok) {
      const errText = await res.text();
      return { ok: false, error: `${res.status}: ${errText.replace(key, '***').slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
