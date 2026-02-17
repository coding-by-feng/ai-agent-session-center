import { useSettingsStore } from '@/stores/settingsStore';
import styles from '@/styles/modules/Settings.module.css';

const SOUND_LIBRARY: string[] = [
  'none', 'beep', 'boop', 'chime', 'click', 'ding', 'ping',
  'pop', 'whoosh', 'alarm', 'urgentAlarm', 'fanfare', 'error',
  'success', 'notification', 'typing',
];

const ACTION_LABELS: Record<string, string> = {
  toolRead: 'Tool: Read',
  toolWrite: 'Tool: Write / Edit',
  toolBash: 'Tool: Bash',
  toolGrep: 'Tool: Grep / Glob',
  toolWebFetch: 'Tool: WebFetch',
  toolTask: 'Tool: Task',
  promptSubmit: 'Prompt Submitted',
  sessionStart: 'Session Start',
  sessionEnd: 'Session End',
  statusApproval: 'Status: Approval',
  statusInput: 'Status: Input',
  statusIdle: 'Status: Idle',
};

const ACTION_CATEGORIES: Record<string, string[]> = {
  'Tool Events': ['toolRead', 'toolWrite', 'toolBash', 'toolGrep', 'toolWebFetch', 'toolTask'],
  'Session Events': ['promptSubmit', 'sessionStart', 'sessionEnd'],
  'Status Changes': ['statusApproval', 'statusInput', 'statusIdle'],
};

export default function SoundSettings() {
  const soundEnabled = useSettingsStore((s) => s.soundSettings.enabled);
  const soundVolume = useSettingsStore((s) => s.soundSettings.volume);
  const updateSoundSettings = useSettingsStore((s) => s.updateSoundSettings);
  const soundActions = useSettingsStore((s) => s.soundActions);
  const setSoundAction = useSettingsStore((s) => s.setSoundAction);
  const activityFeedVisible = useSettingsStore((s) => s.activityFeedVisible);
  const setActivityFeedVisible = useSettingsStore((s) => s.setActivityFeedVisible);
  const toastEnabled = useSettingsStore((s) => s.toastEnabled);
  const setToastEnabled = useSettingsStore((s) => s.setToastEnabled);

  return (
    <div>
      {/* Master Sound Toggle */}
      <div className={styles.section}>
        <h4>Sound</h4>
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

          {/* Volume Slider */}
          <div className={styles.volumeControl}>
            <span>Volume</span>
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

      {/* Per-Action Sound Config */}
      <div className={styles.section}>
        <h4>Per-Action Sounds</h4>
        <div className={styles.soundActionGrid}>
          {Object.entries(ACTION_CATEGORIES).map(([category, actions]) => (
            <div key={category}>
              <div className={styles.soundCategoryLabel}>{category}</div>
              {actions.map((action) => (
                <div key={action} className={styles.soundActionRow}>
                  <span className={styles.soundActionLabel}>
                    {ACTION_LABELS[action] ?? action}
                  </span>
                  <select
                    className={styles.soundActionSelect}
                    value={soundActions[action] ?? 'none'}
                    onChange={(e) => setSoundAction(action, e.target.value)}
                  >
                    {SOUND_LIBRARY.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button
                    className={styles.soundPreviewBtn}
                    title="Preview"
                    onClick={() => {
                      // Sound preview would be handled by the sound system (T26)
                    }}
                  >
                    &#9654;
                  </button>
                </div>
              ))}
            </div>
          ))}
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
