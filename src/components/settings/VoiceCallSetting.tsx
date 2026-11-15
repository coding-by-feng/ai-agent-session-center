/**
 * VoiceCallSetting — Settings → ADVANCED "Voice calls" (Nov 15 2026, server/voice/).
 *
 * The phone app's More → Call AASC talks to OpenAI's GPT-Live voice; the Voice central (a global central session)
 * does the work. The OpenAI key is kept on this Mac (voice.json, owner-only) and never shown again: the section
 * says only whether one is set and its last four characters. This Mac only: any other device gets 404 and sees
 * nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/Settings.module.css';

interface VoiceSettingsView {
  configured: boolean;
  keyHint: string | null;
  voice: string;
}

type BrainState = 'ready' | 'no_central' | 'not_running' | 'centrals_off';

interface VoiceStatus {
  brain: { state: BrainState; title: string | null; shared: boolean };
}

const SETTINGS = '/api/voice/settings';
const STATUS = '/api/voice/status';

/** GPT-Live's English voices (developers.openai.com/api/docs/guides/live-conversations); marin is its default. */
const VOICES = ['marin', 'quartz', 'ripple', 'vesper', 'willow', 'stone', 'gleam', 'meridian', 'beacon', 'delta', 'cinder'];

const BRAIN_WORDS: Record<BrainState, string> = {
  ready: '',
  no_central: 'Keep exactly one global central session running: it answers the calls.',
  not_running: 'The Voice central isn’t running: reconnect it.',
  centrals_off: 'Turn on central sessions above and restart AASC: a central answers the calls.',
};

function brainLine(status: VoiceStatus | null): string | null {
  if (!status) return null;
  const { brain } = status;
  if (brain.state !== 'ready') return BRAIN_WORDS[brain.state];
  const name = brain.title ? `“${brain.title}”` : 'The central session';
  return brain.shared
    ? `${name} answers calls.`
    : `${name} answers calls from this Mac. Share it (📡) to call from your phone.`;
}

async function readJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: T };
  return body.data ?? null;
}

export default function VoiceCallSetting() {
  const [settings, setSettings] = useState<VoiceSettingsView | null>(null);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshStatus = useCallback(() => {
    readJson<VoiceStatus>(STATUS).then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    let cancelled = false;
    readJson<VoiceSettingsView>(SETTINGS)
      .then((data) => {
        if (cancelled) return;
        if (!data) { setHidden(true); return; }
        setSettings(data);
        refreshStatus();
      })
      .catch(() => { if (!cancelled) setHidden(true); });
    return () => { cancelled = true; };
  }, [refreshStatus]);

  const save = useCallback(async (patch: { apiKey?: string | null; voice?: string }, done: string) => {
    setBusy(true);
    try {
      const res = await fetch(SETTINGS, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { data: VoiceSettingsView };
      setSettings(body.data);
      if (patch.apiKey !== undefined) setKeyDraft('');
      showToast(done, 'success');
      refreshStatus();
    } catch {
      showToast(patch.apiKey !== undefined ? 'Couldn’t save the key. Check it and try again.' : 'Couldn’t save the voice. Try again.', 'error');
    } finally {
      setBusy(false);
    }
  }, [refreshStatus]);

  if (hidden || !settings) return null;
  const draft = keyDraft.trim();
  const line = brainLine(status);

  return (
    <div className={styles.section}>
      <h4>Voice calls</h4>
      <p className={styles.settingsHint}>
        Call AASC from the phone app (More → Call AASC). OpenAI’s GPT-Live voice listens and talks; your Voice central
        does the work. OpenAI bills about $0.05 a minute to this key.
      </p>
      <label className={styles.settingsHint} htmlFor="voice-api-key">
        OpenAI API key · {settings.configured ? `set (${settings.keyHint ?? 'saved'})` : 'no key set'}
      </label>
      <div className={styles.apiKeyRow}>
        <input
          id="voice-api-key"
          type="password"
          autoComplete="off"
          className={styles.apiKeyInput}
          placeholder={settings.configured ? 'Paste a new key to replace it' : 'sk-…'}
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
        />
        <button
          type="button"
          className={styles.fontBtn}
          disabled={busy || draft.length < 20}
          onClick={() => void save({ apiKey: draft }, 'Key saved on this Mac')}
        >
          Save key
        </button>
        {settings.configured && (
          <button type="button" className={styles.fontBtn} disabled={busy} onClick={() => void save({ apiKey: null }, 'Key removed')}>
            Remove
          </button>
        )}
      </div>
      <label className={styles.settingsHint} htmlFor="voice-name">Voice</label>
      <select
        id="voice-name"
        className={styles.apiKeyInput}
        value={settings.voice}
        disabled={busy}
        onChange={(e) => void save({ voice: e.target.value }, 'Voice saved')}
      >
        {(VOICES.includes(settings.voice) ? VOICES : [settings.voice, ...VOICES]).map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
      {line && <p className={styles.settingsHint} role="status">{line}</p>}
    </div>
  );
}
