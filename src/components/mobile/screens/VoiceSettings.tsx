/**
 * VoiceSettings — More → Settings → Voice (Oct 20 2026): read aloud on this phone.
 *
 *   GOOGLE CLOUD KEY   [••••••••••••]  Show   Check key      ✓ The key works
 *   READ ALOUD         Read aloud                      (●)  off until a key is saved
 *   VOICES             English voice      Aoede …  ›        a sheet of the desktop's voices
 *                      Chinese voice      Aoede …  ›
 *                      Speed              1×     [−][+]
 *                      [ Play a sample ]
 *
 * The desktop's own voice settings (settingsStore: googleTtsApiKey, ttsEnabled,
 * ttsVoiceEn/Zh, ttsSpeakingRate) and its voice list (ttsVoices.ts), kept in this
 * phone's storage. It replaced "API keys", whose Anthropic and OpenAI keys nothing
 * in AASC reads; until then the phone's 🔊 buttons could only say "set it up".
 * The key goes to the Mac with each request (POST /api/tts/*), never stored there.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, ListRow, ListSection, Sheet } from '../kit';
import { useSettingsStore } from '@/stores/settingsStore';
import { checkTTSStatus, ttsEngine } from '@/lib/ttsEngine';
import { stopReadAloud } from '@/hooks/useReadAloud';
import { TTS_EN_VOICES, TTS_RATES, TTS_SAMPLE_TEXT, TTS_ZH_VOICES, stepTtsRate, ttsVoiceLabel, type TtsVoiceOption } from '@/lib/ttsVoices';
import styles from '@/styles/modules/mobile/MoreScreens.module.css';

const FIT = ['medium', 'large'] as const;
const RATE_MIN = TTS_RATES[0];
const RATE_MAX = TTS_RATES[TTS_RATES.length - 1];

type KeyCheck = { state: 'idle' } | { state: 'checking' } | { state: 'done'; ok: boolean; error?: string };

function formatRate(rate: number): string {
  return `${Number(rate.toFixed(2))}×`;
}

function VoicePicker({ open, title, voices, value, onPick, onClose }: {
  open: boolean; title: string; voices: readonly TtsVoiceOption[]; value: string;
  onPick: (voice: string) => void; onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} detents={FIT} testId="voice-picker">
      <ListSection label={title}>
        {voices.map((v) => {
          const selected = v.value === value;
          return (
            <ListRow
              key={v.value}
              title={v.label}
              value={selected ? 'Selected' : undefined}
              ariaLabel={`${v.label}${selected ? ', selected' : ''}`}
              onClick={() => { onPick(v.value); onClose(); }}
            />
          );
        })}
      </ListSection>
    </Sheet>
  );
}

export default function VoiceSettings() {
  const apiKey = useSettingsStore((s) => s.googleTtsApiKey);
  const enabled = useSettingsStore((s) => s.ttsEnabled);
  const voiceEn = useSettingsStore((s) => s.ttsVoiceEn);
  const voiceZh = useSettingsStore((s) => s.ttsVoiceZh);
  const rate = useSettingsStore((s) => s.ttsSpeakingRate);
  const { setApiKey, setTtsEnabled, setTtsVoiceEn, setTtsVoiceZh, setTtsSpeakingRate } = useSettingsStore.getState();

  const [draft, setDraft] = useState(apiKey);
  const [showKey, setShowKey] = useState(false);
  const [check, setCheck] = useState<KeyCheck>({ state: 'idle' });
  const [picking, setPicking] = useState<'en' | 'zh' | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState<string | null>(null);
  /** The running sample's id: stopping one makes the player reject, which is not an error. */
  const sampleRun = useRef<number | null>(null);
  useEffect(() => {
    const run = sampleRun;
    // Leaving the page stops the sample: nothing would be left on screen to stop it with.
    return () => { if (run.current !== null) stopReadAloud(); };
  }, []);

  const hasKey = apiKey.trim().length > 0;
  const changed = draft.trim() !== apiKey.trim();

  const saveKey = () => {
    const next = draft.trim();
    setApiKey('googleTts', next);
    setCheck({ state: 'idle' });
    // A removed key turns read aloud off, as the desktop's switch can't stay on without one.
    if (!next && enabled) setTtsEnabled(false);
  };

  const checkKey = async () => {
    setCheck({ state: 'checking' });
    const result = await checkTTSStatus(apiKey.trim());
    setCheck({ state: 'done', ok: result.ok, error: result.error });
  };

  const playSample = async () => {
    if (playing) {
      sampleRun.current = null;
      stopReadAloud();
      setPlaying(false);
      return;
    }
    stopReadAloud();
    const run = Date.now();
    sampleRun.current = run;
    setPlaying(true);
    setPlayError(null);
    try {
      await ttsEngine.speak(TTS_SAMPLE_TEXT, { apiKey: apiKey.trim(), voiceEn, voiceZh, speakingRate: rate });
    } catch (err) {
      if (sampleRun.current === run) setPlayError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sampleRun.current === run) {
        sampleRun.current = null;
        setPlaying(false);
      }
    }
  };

  const checkLine = check.state === 'checking'
    ? 'Checking…'
    : check.state === 'done'
      ? (check.ok ? '✓ The key works' : `✗ ${check.error ?? 'The key was refused'}`)
      : null;

  return (
    <>
      <ListSection
        header="Google Cloud key"
        footer="A Google Cloud API key with the Text-to-Speech API turned on. It stays on this phone and goes to your Mac only with each request; your Mac never keeps it."
      >
        <li className={styles.formRow}>
          <form
            className={styles.keyForm}
            onSubmit={(e) => { e.preventDefault(); if (changed) saveKey(); }}
          >
            <label className={styles.field}>
              <span className={styles.fieldLabel}>API key</span>
              <input
                className={styles.input}
                type={showKey ? 'text' : 'password'}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                enterKeyHint="done"
                placeholder="AIza…"
                data-testid="voice-key"
              />
            </label>
            <div className={styles.keyActions}>
              <Button small onClick={() => setShowKey((v) => !v)} aria-label={showKey ? 'Hide the key' : 'Show the key'}>{showKey ? 'Hide' : 'Show'}</Button>
              {/* Save while the box differs from the saved key; Check once they agree. */}
              {changed ? (
                <Button small type="submit" variant="primary">{draft.trim() ? 'Save' : 'Remove the key'}</Button>
              ) : hasKey && (
                <Button small onClick={() => void checkKey()} loading={check.state === 'checking'} loadingLabel="Checking">Check key</Button>
              )}
            </div>
            {checkLine && <p className={styles.keyStatus} role="status" data-ok={check.state === 'done' && check.ok ? '' : undefined}>{checkLine}</p>}
          </form>
        </li>
      </ListSection>

      <ListSection header="Read aloud" footer="A 🔊 button under the latest answer and on text you select in a chat. Your Mac keeps its own setting.">
        <ListRow
          title="Read aloud"
          toggle={{ checked: enabled && hasKey, onChange: setTtsEnabled }}
          disabledReason={hasKey ? undefined : 'Save a key first.'}
          ariaLabel="Read aloud"
        />
      </ListSection>

      <ListSection header="Voices" footer="English and Chinese text each get their own voice.">
        <ListRow title="English voice" value={ttsVoiceLabel(TTS_EN_VOICES, voiceEn)} chevron onClick={() => setPicking('en')} />
        <ListRow title="Chinese voice" value={ttsVoiceLabel(TTS_ZH_VOICES, voiceZh)} chevron onClick={() => setPicking('zh')} />
        <li className={styles.stepperRow}>
          <span>Speed <span className={styles.stepperValue}>{formatRate(rate)}</span></span>
          <span className={styles.stepperButtons}>
            <Button small onClick={() => setTtsSpeakingRate(stepTtsRate(rate, -1))} disabledReason={rate <= RATE_MIN ? 'Slowest already.' : undefined} aria-label="Slower">−</Button>
            <Button small onClick={() => setTtsSpeakingRate(stepTtsRate(rate, 1))} disabledReason={rate >= RATE_MAX ? 'Fastest already.' : undefined} aria-label="Faster">+</Button>
          </span>
        </li>
      </ListSection>

      <div className={styles.sampleRow}>
        <Button
          onClick={() => void playSample()}
          disabledReason={!hasKey ? 'Save a key first.' : !enabled ? 'Turn Read aloud on first.' : undefined}
        >
          {playing ? 'Stop the sample' : 'Play a sample'}
        </Button>
        {playError && <p className={styles.keyStatus} role="alert">{playError}</p>}
      </div>

      <VoicePicker open={picking === 'en'} title="English voice" voices={TTS_EN_VOICES} value={voiceEn} onPick={setTtsVoiceEn} onClose={() => setPicking(null)} />
      <VoicePicker open={picking === 'zh'} title="Chinese voice" voices={TTS_ZH_VOICES} value={voiceZh} onPick={setTtsVoiceZh} onClose={() => setPicking(null)} />
    </>
  );
}
