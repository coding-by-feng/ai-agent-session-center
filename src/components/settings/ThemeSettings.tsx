import { useSettingsStore, THEMES, type ThemeName } from '@/stores/settingsStore';
import styles from '@/styles/modules/Settings.module.css';

export default function ThemeSettings() {
  const themeName = useSettingsStore((s) => s.themeName);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const scanlineEnabled = useSettingsStore((s) => s.scanlineEnabled);
  const animationIntensity = useSettingsStore((s) => s.animationIntensity);
  const animationSpeed = useSettingsStore((s) => s.animationSpeed);
  const setThemeName = useSettingsStore((s) => s.setThemeName);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const setScanlineEnabled = useSettingsStore((s) => s.setScanlineEnabled);
  const setAnimationIntensity = useSettingsStore((s) => s.setAnimationIntensity);
  const setAnimationSpeed = useSettingsStore((s) => s.setAnimationSpeed);

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
          Intensity (range of movement)
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
          Speed
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
