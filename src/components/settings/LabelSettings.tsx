import { useSettingsStore, FRAME_EFFECTS, type LabelConfig } from '@/stores/settingsStore';
import styles from '@/styles/modules/Settings.module.css';

const LABELS = ['ONEOFF', 'HEAVY', 'IMPORTANT'] as const;

const LABEL_COLORS: Record<string, string> = {
  ONEOFF: '#ff9100',
  HEAVY: '#ff3355',
  IMPORTANT: '#aa66ff',
};

const LABEL_ICONS: Record<string, string> = {
  ONEOFF: '\u{1F525}',  // fire emoji
  HEAVY: '\u2B50',       // star
  IMPORTANT: '\u26A0',   // warning
};

const SOUND_OPTIONS: string[] = [
  'none', 'beep', 'boop', 'chime', 'click', 'ding', 'ping',
  'pop', 'whoosh', 'alarm', 'urgentAlarm', 'fanfare', 'error',
  'success', 'notification',
];

const MOVEMENT_OPTIONS: Record<string, string> = {
  none: 'None',
  shake: 'Shake',
  bounce: 'Bounce',
  flash: 'Flash',
  spin: 'Spin',
  pulse: 'Pulse',
  wobble: 'Wobble',
  float: 'Float',
  jello: 'Jello',
};

export default function LabelSettings() {
  const labelSettings = useSettingsStore((s) => s.labelSettings);
  const setLabelSetting = useSettingsStore((s) => s.setLabelSetting);

  return (
    <div>
      <div className={styles.section}>
        <h4>Label Completion Alerts</h4>
        <p className={styles.settingsHint}>
          Configure sound, movement, and robot body effects when a labeled session completes.
        </p>
        <div className={styles.labelSettingsGrid}>
          {LABELS.map((label) => {
            const cfg: LabelConfig = labelSettings[label] ?? {
              sound: 'none',
              movement: 'none',
              frame: 'none',
            };
            const color = LABEL_COLORS[label];

            return (
              <div
                key={label}
                className={styles.labelConfigCard}
                style={{ '--label-color': color } as React.CSSProperties}
                data-frame={cfg.frame || 'none'}
              >
                <div className={styles.labelConfigHeader}>
                  <span className={styles.labelConfigIcon}>{LABEL_ICONS[label]}</span>
                  <span className={styles.labelConfigName}>{label}</span>
                </div>

                {/* Frame Effect */}
                <div className={styles.labelConfigRow}>
                  <span className={styles.labelConfigField}>Robot Effect</span>
                  <select
                    className={styles.labelConfigSelect}
                    value={cfg.frame}
                    onChange={(e) => setLabelSetting(label, 'frame', e.target.value)}
                  >
                    {Object.entries(FRAME_EFFECTS).map(([key, name]) => (
                      <option key={key} value={key}>{name}</option>
                    ))}
                  </select>
                </div>

                {/* Sound */}
                <div className={styles.labelConfigRow}>
                  <span className={styles.labelConfigField}>Sound</span>
                  <select
                    className={styles.labelConfigSelect}
                    value={cfg.sound}
                    onChange={(e) => setLabelSetting(label, 'sound', e.target.value)}
                  >
                    {SOUND_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button
                    className={styles.soundPreviewBtn}
                    title="Preview"
                    onClick={() => {
                      // Sound preview handled by sound system (T26)
                    }}
                  >
                    &#9654;
                  </button>
                </div>

                {/* Movement */}
                <div className={styles.labelConfigRow}>
                  <span className={styles.labelConfigField}>Movement</span>
                  <select
                    className={styles.labelConfigSelect}
                    value={cfg.movement}
                    onChange={(e) => setLabelSetting(label, 'movement', e.target.value)}
                  >
                    {Object.entries(MOVEMENT_OPTIONS).map(([key, name]) => (
                      <option key={key} value={key}>{name}</option>
                    ))}
                  </select>
                  <button
                    className={styles.soundPreviewBtn}
                    title="Preview"
                    onClick={() => {
                      // Movement preview handled by movement system
                    }}
                  >
                    &#9654;
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
