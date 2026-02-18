import { useSettingsStore, THEMES, type ThemeName } from '@/stores/settingsStore';
import { ROBOT_MODEL_TYPES, getModelLabel, getModelDescription, type RobotModelType } from '@/lib/robot3DModels';
import styles from '@/styles/modules/Settings.module.css';

export default function ThemeSettings() {
  const themeName = useSettingsStore((s) => s.themeName);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const scanlineEnabled = useSettingsStore((s) => s.scanlineEnabled);
  const animationIntensity = useSettingsStore((s) => s.animationIntensity);
  const animationSpeed = useSettingsStore((s) => s.animationSpeed);
  const characterModel = useSettingsStore((s) => s.characterModel);
  const setThemeName = useSettingsStore((s) => s.setThemeName);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setScanlineEnabled = useSettingsStore((s) => s.setScanlineEnabled);
  const setAnimationIntensity = useSettingsStore((s) => s.setAnimationIntensity);
  const setAnimationSpeed = useSettingsStore((s) => s.setAnimationSpeed);
  const setCharacterModel = useSettingsStore((s) => s.setCharacterModel);

  return (
    <div>
      {/* Theme Grid */}
      <div className={styles.section}>
        <h4>Theme</h4>
        <div className={styles.themeGrid}>
          {THEMES.map((t) => (
            <button
              key={t.name}
              className={`${styles.themeSwatch}${themeName === t.name ? ` ${styles.active}` : ''}`}
              onClick={() => setThemeName(t.name as ThemeName)}
              title={t.label}
            >
              <div className={styles.swatchColors}>
                {t.colors.map((color, i) => (
                  <span key={i} style={{ background: color }} />
                ))}
              </div>
              <span className={styles.swatchLabel}>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Character Model Picker */}
      <div className={styles.section}>
        <h4>3D Character Model</h4>
        <p style={{ fontSize: '10px', color: 'var(--text-dim)', marginBottom: '8px' }}>
          Choose the robot model shown in the Cyberdrome
        </p>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '6px',
        }}>
          {ROBOT_MODEL_TYPES.map((type) => {
            const isActive = characterModel === type;
            return (
              <button
                key={type}
                onClick={() => setCharacterModel(type)}
                title={getModelDescription(type)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: '4px',
                  padding: '8px 4px',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  border: isActive
                    ? '1px solid var(--accent-cyan, #00e5ff)'
                    : '1px solid var(--border-subtle, rgba(255,255,255,0.08))',
                  background: isActive
                    ? 'rgba(0, 229, 255, 0.1)'
                    : 'rgba(255, 255, 255, 0.02)',
                  color: isActive
                    ? 'var(--accent-cyan, #00e5ff)'
                    : 'var(--text-secondary, #8888aa)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  letterSpacing: '0.5px',
                }}
              >
                <ModelIcon type={type} active={isActive} />
                <span style={{ textTransform: 'uppercase', fontWeight: isActive ? 700 : 400 }}>
                  {getModelLabel(type)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Font Size */}
      <div className={styles.section}>
        <h4>Font Size</h4>
        <div className={styles.fontSizeControl}>
          <button
            className={styles.fontBtn}
            onClick={() => setFontSize(Math.max(10, fontSize - 1))}
          >
            A-
          </button>
          <span className={styles.fontSizeDisplay}>{fontSize}px</span>
          <button
            className={styles.fontBtn}
            onClick={() => setFontSize(Math.min(20, fontSize + 1))}
          >
            A+
          </button>
          <input
            type="range"
            className={styles.fontSizeSlider}
            min={10}
            max={20}
            step={1}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
        </div>
      </div>

      {/* Scanline Effect */}
      <div className={styles.section}>
        <h4>Scanline Effect</h4>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={scanlineEnabled}
            onChange={(e) => setScanlineEnabled(e.target.checked)}
          />
          <span className={styles.toggleSwitch} />
          <span>Enable scanline overlay</span>
        </label>
      </div>

      {/* Animation Controls */}
      <div className={styles.section}>
        <h4>Animation</h4>
        <label style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', display: 'block' }}>
          Intensity (range of 3D robot movement)
        </label>
        <div className={styles.volumeControl}>
          <span>Low</span>
          <input
            type="range"
            min={0}
            max={200}
            step={10}
            value={animationIntensity}
            onChange={(e) => setAnimationIntensity(Number(e.target.value))}
          />
          <span style={{ minWidth: '40px', textAlign: 'right' }}>{animationIntensity}%</span>
        </div>

        <label style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px', marginTop: '8px', display: 'block' }}>
          Speed (3D robot animation speed)
        </label>
        <div className={styles.volumeControl}>
          <span>Slow</span>
          <input
            type="range"
            min={30}
            max={200}
            step={10}
            value={animationSpeed}
            onChange={(e) => setAnimationSpeed(Number(e.target.value))}
          />
          <span style={{ minWidth: '40px', textAlign: 'right' }}>{animationSpeed}%</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model Icon — simple SVG icon for each model type
// ---------------------------------------------------------------------------

function ModelIcon({ type, active }: { type: RobotModelType; active: boolean }) {
  const color = active ? '#00e5ff' : '#666';
  const size = 28;

  switch (type) {
    case 'robot':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <rect x="8" y="2" width="8" height="6" rx="1" stroke={color} strokeWidth="1.5" />
          <rect x="7" y="9" width="10" height="8" rx="1" stroke={color} strokeWidth="1.5" />
          <line x1="9" y1="17" x2="9" y2="22" stroke={color} strokeWidth="1.5" />
          <line x1="15" y1="17" x2="15" y2="22" stroke={color} strokeWidth="1.5" />
          <line x1="5" y1="12" x2="7" y2="12" stroke={color} strokeWidth="1.5" />
          <line x1="17" y1="12" x2="19" y2="12" stroke={color} strokeWidth="1.5" />
        </svg>
      );
    case 'mech':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <rect x="7" y="2" width="10" height="5" rx="1" stroke={color} strokeWidth="1.5" />
          <rect x="5" y="8" width="14" height="9" rx="1" stroke={color} strokeWidth="1.5" />
          <line x1="8" y1="17" x2="7" y2="22" stroke={color} strokeWidth="2" />
          <line x1="16" y1="17" x2="17" y2="22" stroke={color} strokeWidth="2" />
          <line x1="3" y1="11" x2="5" y2="11" stroke={color} strokeWidth="2" />
          <line x1="19" y1="11" x2="21" y2="11" stroke={color} strokeWidth="2" />
        </svg>
      );
    case 'drone':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="10" r="4" stroke={color} strokeWidth="1.5" />
          <rect x="8" y="12" width="8" height="4" rx="1" stroke={color} strokeWidth="1.5" />
          <line x1="4" y1="13" x2="8" y2="13" stroke={color} strokeWidth="1.5" />
          <line x1="16" y1="13" x2="20" y2="13" stroke={color} strokeWidth="1.5" />
          <line x1="12" y1="4" x2="12" y2="6" stroke={color} strokeWidth="1.5" />
          <circle cx="12" cy="3" r="1" fill={color} />
        </svg>
      );
    case 'spider':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <ellipse cx="12" cy="12" rx="6" ry="3" stroke={color} strokeWidth="1.5" />
          <circle cx="12" cy="9" r="2.5" stroke={color} strokeWidth="1.5" />
          <line x1="7" y1="13" x2="3" y2="18" stroke={color} strokeWidth="1.5" />
          <line x1="17" y1="13" x2="21" y2="18" stroke={color} strokeWidth="1.5" />
          <line x1="8" y1="14" x2="5" y2="20" stroke={color} strokeWidth="1.5" />
          <line x1="16" y1="14" x2="19" y2="20" stroke={color} strokeWidth="1.5" />
        </svg>
      );
    case 'orb':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="11" r="6" stroke={color} strokeWidth="1.5" />
          <circle cx="12" cy="5" r="2" stroke={color} strokeWidth="1.5" />
          <line x1="9" y1="17" x2="8" y2="21" stroke={color} strokeWidth="1.5" />
          <line x1="15" y1="17" x2="16" y2="21" stroke={color} strokeWidth="1.5" />
          <line x1="6" y1="10" x2="3" y2="9" stroke={color} strokeWidth="1.5" />
          <line x1="18" y1="10" x2="21" y2="9" stroke={color} strokeWidth="1.5" />
        </svg>
      );
    case 'tank':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <rect x="7" y="3" width="8" height="5" rx="1" stroke={color} strokeWidth="1.5" />
          <rect x="4" y="9" width="14" height="7" rx="1" stroke={color} strokeWidth="1.5" />
          <rect x="5" y="17" width="5" height="3" rx="0.5" stroke={color} strokeWidth="1.5" />
          <rect x="14" y="17" width="5" height="3" rx="0.5" stroke={color} strokeWidth="1.5" />
          <line x1="18" y1="11" x2="22" y2="11" stroke={color} strokeWidth="2" />
        </svg>
      );
    default:
      return null;
  }
}
