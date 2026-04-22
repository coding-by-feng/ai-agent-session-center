import { useState, useMemo } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  soundEngine,
  ACTION_LABELS,
  ACTION_CATEGORIES,
  type SoundName,
  type SoundAction,
} from '@/lib/soundEngine';
import { ambientEngine } from '@/lib/ambientEngine';
import { ttsEngine, checkTTSStatus } from '@/lib/ttsEngine';
import type { AmbientPreset } from '@/types';
import Select from '@/components/ui/Select';
import type { SelectOption } from '@/components/ui/Select';
import styles from '@/styles/modules/Settings.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_TABS = [
  { id: 'claude', label: 'Claude' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'codex', label: 'Codex' },
  { id: 'openclaw', label: 'OpenClaw' },
] as const;

type CliTabId = (typeof CLI_TABS)[number]['id'];

const SOUND_NAMES = soundEngine.getSoundNames();
const SOUND_OPTIONS: SelectOption[] = SOUND_NAMES.map((s) => ({ value: s, label: s }));

const TTS_EN_VOICES: SelectOption[] = [
  { value: 'en-US-Chirp3-HD-Aoede', label: 'Aoede (Chirp 3 HD, female)' },
  { value: 'en-US-Chirp3-HD-Charon', label: 'Charon (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Fenrir', label: 'Fenrir (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Kore', label: 'Kore (Chirp 3 HD, female)' },
  { value: 'en-US-Chirp3-HD-Leda', label: 'Leda (Chirp 3 HD, female)' },
  { value: 'en-US-Chirp3-HD-Orus', label: 'Orus (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Puck', label: 'Puck (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Zephyr', label: 'Zephyr (Chirp 3 HD, female)' },
  { value: 'en-US-Studio-O', label: 'Studio O (female)' },
  { value: 'en-US-Studio-Q', label: 'Studio Q (male)' },
  { value: 'en-US-Neural2-F', label: 'Neural2 F (female)' },
  { value: 'en-US-Neural2-D', label: 'Neural2 D (male)' },
];

const TTS_ZH_VOICES: SelectOption[] = [
  { value: 'cmn-CN-Chirp3-HD-Aoede', label: 'Aoede (Chirp 3 HD, female)' },
  { value: 'cmn-CN-Chirp3-HD-Charon', label: 'Charon (Chirp 3 HD, male)' },
  { value: 'cmn-CN-Chirp3-HD-Kore', label: 'Kore (Chirp 3 HD, female)' },
  { value: 'cmn-CN-Chirp3-HD-Puck', label: 'Puck (Chirp 3 HD, male)' },
  { value: 'cmn-CN-Wavenet-A', label: 'Wavenet A (female)' },
  { value: 'cmn-CN-Wavenet-B', label: 'Wavenet B (male)' },
];

const AMBIENT_PRESETS: Array<{ value: AmbientPreset; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'rain', label: 'Rain' },
  { value: 'lofi', label: 'Lo-fi Hum' },
  { value: 'serverRoom', label: 'Server Room' },
  { value: 'deepSpace', label: 'Deep Space' },
  { value: 'coffeeShop', label: 'Coffee Shop' },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SoundSettings() {
  const [activeCliTab, setActiveCliTab] = useState<CliTabId>('claude');

  // Master settings
  const soundEnabled = useSettingsStore((s) => s.soundSettings.enabled);
  const soundVolume = useSettingsStore((s) => s.soundSettings.volume);
  const updateSoundSettings = useSettingsStore((s) => s.updateSoundSettings);

  // Per-CLI settings
  const perCli = useSettingsStore((s) => s.soundSettings.perCli);
  const updateCliSoundConfig = useSettingsStore((s) => s.updateCliSoundConfig);
  const setCliActionSound = useSettingsStore((s) => s.setCliActionSound);

  // Ambient settings
  const ambientSettings = useSettingsStore((s) => s.ambientSettings);
  const updateAmbientSettings = useSettingsStore((s) => s.updateAmbientSettings);

  // TTS settings
  const ttsEnabled = useSettingsStore((s) => s.ttsEnabled);
  const ttsVoiceEn = useSettingsStore((s) => s.ttsVoiceEn);
  const ttsVoiceZh = useSettingsStore((s) => s.ttsVoiceZh);
  const ttsRate = useSettingsStore((s) => s.ttsSpeakingRate);
  const googleTtsApiKey = useSettingsStore((s) => s.googleTtsApiKey);
  const setTtsEnabled = useSettingsStore((s) => s.setTtsEnabled);
  const setTtsVoiceEn = useSettingsStore((s) => s.setTtsVoiceEn);
  const setTtsVoiceZh = useSettingsStore((s) => s.setTtsVoiceZh);
  const setTtsSpeakingRate = useSettingsStore((s) => s.setTtsSpeakingRate);
  const setApiKey = useSettingsStore((s) => s.setApiKey);
  const [ttsStatus, setTtsStatus] = useState<{ ok: boolean; error?: string } | null>(null);
  const [ttsPreviewBusy, setTtsPreviewBusy] = useState(false);
  const [ttsKeyVisible, setTtsKeyVisible] = useState(false);
  const ttsKeyConfigured = googleTtsApiKey.trim().length > 0;

  // Notifications
  const activityFeedVisible = useSettingsStore((s) => s.activityFeedVisible);
  const setActivityFeedVisible = useSettingsStore((s) => s.setActivityFeedVisible);
  const toastEnabled = useSettingsStore((s) => s.toastEnabled);
  const setToastEnabled = useSettingsStore((s) => s.setToastEnabled);

  const activeCliConfig = perCli[activeCliTab];

  function handlePreview(soundName: SoundName) {
    soundEngine.preview(soundName);
  }

  function handleAmbientPresetChange(preset: AmbientPreset) {
    updateAmbientSettings({ preset });
    if (preset === 'off') {
      ambientEngine.stop();
    } else if (ambientSettings.enabled) {
      ambientEngine.start(preset, ambientSettings.volume);
    }
  }

  function handleAmbientToggle(enabled: boolean) {
    updateAmbientSettings({ enabled });
    if (enabled && ambientSettings.preset !== 'off') {
      ambientEngine.start(ambientSettings.preset, ambientSettings.volume);
    } else {
      ambientEngine.stop();
    }
  }

  function handleAmbientVolume(volume: number) {
    updateAmbientSettings({ volume });
    ambientEngine.setVolume(volume);
  }

  async function handleTtsCheckStatus() {
    const status = await checkTTSStatus(googleTtsApiKey);
    setTtsStatus(status);
  }

  async function handleTtsPreview() {
    if (ttsPreviewBusy || !ttsKeyConfigured) return;
    setTtsPreviewBusy(true);
    try {
      await ttsEngine.speak('Hello. 你好,这是语音预览。Ready to read your terminal output.', {
        apiKey: googleTtsApiKey,
        voiceEn: ttsVoiceEn,
        voiceZh: ttsVoiceZh,
        speakingRate: ttsRate,
      });
    } catch (err) {
      setTtsStatus({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTtsPreviewBusy(false);
    }
  }

  return (
    <div>
      {/* Master Sound Toggle + Volume */}
      <div className={styles.section}>
        <h4>Master Sound</h4>
        <div className={styles.soundControls}>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={soundEnabled}
              onChange={(e) => updateSoundSettings({ enabled: e.target.checked })}
            />
            <span className={styles.toggleSwitch} />
            <span>Enable sound effects</span>
          </label>

          <div className={styles.volumeControl}>
            <span>Master Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={soundVolume}
              onChange={(e) => updateSoundSettings({ volume: Number(e.target.value) })}
            />
            <span className={styles.volumeDisplay}>
              {Math.round(soundVolume * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Voice (TTS) */}
      <div className={styles.section}>
        <h4>Voice (Text-to-Speech)</h4>
        <p style={{ margin: '4px 0 10px', fontSize: 12, opacity: 0.75 }}>
          Hold <kbd>Space</kbd> while focused on a session terminal to hear the latest output read aloud.
          Each user supplies their own Google Cloud API key (restricted to Text-to-Speech API) — no shared credentials.{' '}
          <a
            href="https://console.cloud.google.com/apis/credentials"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: 'var(--accent-cyan, #3bd6c6)' }}
          >
            Create one in GCP Console
          </a>.
        </p>

        {/* Per-user API key */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, opacity: 0.8, minWidth: 110 }}>Google TTS API key</label>
          <input
            type={ttsKeyVisible ? 'text' : 'password'}
            value={googleTtsApiKey}
            onChange={(e) => setApiKey('googleTts', e.target.value.trim())}
            placeholder="AIza..."
            spellCheck={false}
            autoComplete="off"
            style={{
              flex: '1 1 260px',
              padding: '6px 8px',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: 12,
              background: 'var(--bg-elev-1, rgba(255,255,255,0.04))',
              border: '1px solid var(--border-subtle, rgba(255,255,255,0.1))',
              borderRadius: 4,
              color: 'inherit',
            }}
          />
          <button
            className={styles.testBtn ?? styles.button}
            onClick={() => setTtsKeyVisible((v) => !v)}
            type="button"
          >
            {ttsKeyVisible ? 'Hide' : 'Show'}
          </button>
        </div>

        {!ttsKeyConfigured && (
          <div style={{ fontSize: 12, color: 'var(--accent-yellow, #ffd700)', marginBottom: 10 }}>
            Paste your own Google Cloud API key above to use voice output. The key is stored locally in this browser only.
          </div>
        )}

        <div className={styles.soundControls}>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={ttsEnabled}
              onChange={(e) => setTtsEnabled(e.target.checked)}
              disabled={!ttsKeyConfigured}
            />
            <span className={styles.toggleSwitch} />
            <span>Enable voice output</span>
          </label>

          <div className={styles.volumeControl}>
            <span>Speaking rate</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={ttsRate}
              onChange={(e) => setTtsSpeakingRate(Number(e.target.value))}
              disabled={!ttsEnabled}
            />
            <span className={styles.volumeDisplay}>{ttsRate.toFixed(2)}x</span>
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
            marginTop: 12,
            opacity: ttsEnabled ? 1 : 0.5,
            pointerEvents: ttsEnabled ? 'auto' : 'none',
          }}
        >
          <div>
            <label style={{ fontSize: 12, opacity: 0.8 }}>English voice</label>
            <Select value={ttsVoiceEn} onChange={setTtsVoiceEn} options={TTS_EN_VOICES} />
          </div>
          <div>
            <label style={{ fontSize: 12, opacity: 0.8 }}>中文 voice</label>
            <Select value={ttsVoiceZh} onChange={setTtsVoiceZh} options={TTS_ZH_VOICES} />
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            className={styles.testBtn ?? styles.button}
            onClick={handleTtsPreview}
            disabled={!ttsEnabled || ttsPreviewBusy || !ttsKeyConfigured}
          >
            {ttsPreviewBusy ? 'Speaking…' : 'Preview voice'}
          </button>
          <button
            className={styles.testBtn ?? styles.button}
            onClick={handleTtsCheckStatus}
            disabled={!ttsKeyConfigured}
          >
            Test API key
          </button>
          {ttsStatus && (
            <span style={{ fontSize: 12, opacity: 0.9, color: ttsStatus.ok ? 'var(--accent-green, #7ee787)' : 'var(--accent-red, #ff6b6b)' }}>
              {ttsStatus.ok ? '✓ API key is valid' : `✗ ${ttsStatus.error ?? 'Invalid key'}`}
            </span>
          )}
        </div>
      </div>

      {/* Per-CLI Tabs */}
      <div className={styles.section}>
        <h4>Per-CLI Sound Profiles</h4>

        {/* CLI Tab Bar */}
        <div className={styles.tabs} style={{ marginBottom: 0, paddingLeft: 0 }}>
          {CLI_TABS.map((tab) => (
            <button
              key={tab.id}
              className={`${styles.tab}${activeCliTab === tab.id ? ` ${styles.active}` : ''}`}
              onClick={() => setActiveCliTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Active CLI Config */}
        <div style={{ padding: '12px 0' }}>
          {/* CLI enable + volume */}
          <div className={styles.soundControls} style={{ marginBottom: 12 }}>
            <label className={styles.toggleLabel}>
              <input
                type="checkbox"
                checked={activeCliConfig.enabled}
                onChange={(e) =>
                  updateCliSoundConfig(activeCliTab, { enabled: e.target.checked })
                }
              />
              <span className={styles.toggleSwitch} />
              <span>Enable {CLI_TABS.find((t) => t.id === activeCliTab)?.label} sounds</span>
            </label>

            <div className={styles.volumeControl}>
              <span>Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={activeCliConfig.volume}
                onChange={(e) =>
                  updateCliSoundConfig(activeCliTab, { volume: Number(e.target.value) })
                }
              />
              <span className={styles.volumeDisplay}>
                {Math.round(activeCliConfig.volume * 100)}%
              </span>
            </div>
          </div>

          {/* Per-Action Sound Dropdowns */}
          <div className={styles.soundActionGrid}>
            {ACTION_CATEGORIES.map((category) => (
              <div key={category.label}>
                <div className={styles.soundCategoryLabel}>{category.label}</div>
                {category.actions.map((action: SoundAction) => {
                  const currentSound = (activeCliConfig.actions[action] ?? 'none') as SoundName;
                  return (
                    <div key={action} className={styles.soundActionRow}>
                      <span className={styles.soundActionLabel}>
                        {ACTION_LABELS[action]}
                      </span>
                      <Select
                        value={currentSound}
                        onChange={(val) =>
                          setCliActionSound(activeCliTab, action, val)
                        }
                        options={SOUND_OPTIONS}
                      />
                      <button
                        className={styles.soundPreviewBtn}
                        title="Preview sound"
                        onClick={() => handlePreview(currentSound)}
                      >
                        &#9654;
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Ambient & White Noise */}
      <div className={styles.section}>
        <h4>Ambient & White Noise</h4>
        <div className={styles.soundControls}>
          <label className={styles.toggleLabel}>
            <input
              type="checkbox"
              checked={ambientSettings.enabled}
              onChange={(e) => handleAmbientToggle(e.target.checked)}
            />
            <span className={styles.toggleSwitch} />
            <span>Enable ambient sounds</span>
          </label>

          <div className={styles.volumeControl}>
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={ambientSettings.volume}
              onChange={(e) => handleAmbientVolume(Number(e.target.value))}
            />
            <span className={styles.volumeDisplay}>
              {Math.round(ambientSettings.volume * 100)}%
            </span>
          </div>

          {/* Preset Dropdown */}
          <div className={styles.soundActionRow} style={{ padding: 0 }}>
            <span className={styles.soundActionLabel}>Preset</span>
            <Select
              value={ambientSettings.preset}
              onChange={(val) => handleAmbientPresetChange(val as AmbientPreset)}
              options={AMBIENT_PRESETS.map((p) => ({ value: p.value, label: p.label }))}
              style={{ width: 140 }}
            />
          </div>

          {/* Room Activity Sounds */}
          <label className={styles.toggleLabel} style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={ambientSettings.roomSounds}
              onChange={(e) => updateAmbientSettings({ roomSounds: e.target.checked })}
            />
            <span className={styles.toggleSwitch} />
            <span>Room activity sounds</span>
          </label>

          {ambientSettings.roomSounds && (
            <div className={styles.volumeControl}>
              <span>Room Volume</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={ambientSettings.roomVolume}
                onChange={(e) =>
                  updateAmbientSettings({ roomVolume: Number(e.target.value) })
                }
              />
              <span className={styles.volumeDisplay}>
                {Math.round(ambientSettings.roomVolume * 100)}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Notifications */}
      <div className={styles.section}>
        <h4>Notifications</h4>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={activityFeedVisible}
            onChange={(e) => setActivityFeedVisible(e.target.checked)}
          />
          <span className={styles.toggleSwitch} />
          <span>Show activity feed</span>
        </label>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={toastEnabled}
            onChange={(e) => setToastEnabled(e.target.checked)}
          />
          <span className={styles.toggleSwitch} />
          <span>Show toast notifications</span>
        </label>
      </div>
    </div>
  );
}
