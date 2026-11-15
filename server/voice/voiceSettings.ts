// voiceSettings.ts — the voice call's own settings file (`voice.json` beside server-config.json): the OpenAI project
// key, the GPT-Live voice, and which central answers calls.
//
// The key is the person's own and lives only on this Mac: written owner-only (0600), atomically, and never sent to
// any client (publicVoiceSettings carries only whether one is set and its last four characters). There is no
// fallback to an ambient OPENAI_API_KEY, the same rule as the Google TTS key (tts-voice-output.md).

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** GPT-Live's default voice (live-conversations guide). */
export const DEFAULT_VOICE = 'marin';

/** A voice name as OpenAI writes them: lowercase letters, digits, `_` or `-`. */
export const VOICE_NAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;

export interface VoiceSettings {
  apiKey: string | null;
  voice: string;
  /** The central that answers calls; null picks the only global central. */
  brainCentralId: string | null;
}

export type VoiceSettingsPatch = Partial<VoiceSettings>;

export interface PublicVoiceSettings {
  configured: boolean;
  keyHint: string | null;
  voice: string;
  brainCentralId: string | null;
}

export function voiceSettingsFile(): string {
  if (process.env.AASC_VOICE_FILE) return process.env.AASC_VOICE_FILE;
  return process.env.APP_USER_DATA
    ? join(process.env.APP_USER_DATA, 'voice.json')
    : join(__dirname, '..', '..', 'data', 'voice.json');
}

const DEFAULTS: VoiceSettings = { apiKey: null, voice: DEFAULT_VOICE, brainCentralId: null };

function fromStored(raw: unknown): VoiceSettings {
  if (!raw || typeof raw !== 'object') return DEFAULTS;
  const r = raw as Record<string, unknown>;
  return {
    apiKey: typeof r.apiKey === 'string' && r.apiKey.length > 0 ? r.apiKey : null,
    voice: typeof r.voice === 'string' && VOICE_NAME_RE.test(r.voice) ? r.voice : DEFAULT_VOICE,
    brainCentralId: typeof r.brainCentralId === 'string' && r.brainCentralId.length > 0 ? r.brainCentralId : null,
  };
}

export function readVoiceSettings(file: string = voiceSettingsFile()): VoiceSettings {
  try {
    return fromStored(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return DEFAULTS;
  }
}

/** Saves the fields `patch` names (null clears the key or the central); temp file, then rename. */
export function saveVoiceSettings(patch: VoiceSettingsPatch, file: string = voiceSettingsFile()): VoiceSettings {
  const next: VoiceSettings = { ...readVoiceSettings(file), ...patch };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return next;
}

/** What a client may see: never the key. */
export function publicVoiceSettings(s: VoiceSettings): PublicVoiceSettings {
  const key = s.apiKey;
  return {
    configured: key !== null,
    keyHint: key !== null && key.length >= 12 ? `…${key.slice(-4)}` : null,
    voice: s.voice,
    brainCentralId: s.brainCentralId,
  };
}
