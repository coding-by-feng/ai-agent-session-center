import { useState } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  soundEngine,
  ACTION_LABELS,
  ACTION_CATEGORIES,
  type SoundName,
  type SoundAction,
} from '@/lib/soundEngine';
import { ambientEngine } from '@/lib/ambientEngine';
import type { AmbientPreset } from '@/types';
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
                      <select
                        className={styles.soundActionSelect}
                        value={currentSound}
                        onChange={(e) =>
                          setCliActionSound(activeCliTab, action, e.target.value)
                        }
                      >
                        {SOUND_NAMES.map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
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
            <select
              className={styles.soundActionSelect}
              style={{ width: 140 }}
              value={ambientSettings.preset}
              onChange={(e) => handleAmbientPresetChange(e.target.value as AmbientPreset)}
            >
              {AMBIENT_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
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
