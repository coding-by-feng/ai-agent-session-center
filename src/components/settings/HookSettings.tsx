import { useState, useEffect, useCallback } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import type { HooksStatusResponse, HookDensity } from '@/types';
import styles from '@/styles/modules/Settings.module.css';

const DENSITY_OPTIONS: Array<{ value: HookDensity; label: string; desc: string }> = [
  { value: 'high', label: 'High', desc: 'All events (full monitoring)' },
  { value: 'medium', label: 'Medium', desc: 'Balanced (default)' },
  { value: 'low', label: 'Low', desc: 'Minimal (start/stop only)' },
];

export default function HookSettings() {
  const hookDensity = useSettingsStore((s) => s.hookDensity);
  const setHookDensity = useSettingsStore((s) => s.setHookDensity);
  const autoSendQueue = useSettingsStore((s) => s.autoSendQueue);
  const setAutoSendQueue = useSettingsStore((s) => s.setAutoSendQueue);
  const defaultTerminalTheme = useSettingsStore((s) => s.defaultTerminalTheme);
  const setDefaultTerminalTheme = useSettingsStore((s) => s.setDefaultTerminalTheme);

  const [status, setStatus] = useState<HooksStatusResponse | null>(null);
  const [selectedDensity, setSelectedDensity] = useState<HookDensity>(
    hookDensity === 'off' ? 'medium' : hookDensity,
  );
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch('/api/hooks/status');
      const data: HooksStatusResponse = await resp.json();
      setStatus(data);
      if (data.installed && data.density !== 'off' && data.density !== 'custom') {
        setSelectedDensity(data.density as HookDensity);
      }
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    try {
      const resp = await fetch('/api/hooks/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ density: selectedDensity }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Install failed');
      setHookDensity(selectedDensity);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Install failed');
    } finally {
      setInstalling(false);
    }
  }

  async function handleUninstall() {
    setUninstalling(true);
    setError(null);
    try {
      const resp = await fetch('/api/hooks/uninstall', { method: 'POST' });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Uninstall failed');
      setHookDensity('off');
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Uninstall failed');
    } finally {
      setUninstalling(false);
    }
  }

  return (
    <div>
      {/* Hook Density */}
      <div className={styles.section}>
        <h4>Hook Density</h4>
        <p className={styles.settingsHint}>
          Controls which Claude events are monitored. Higher density provides more detail but
          slightly increases hook overhead.
        </p>
        <div className={styles.densityControl}>
          {DENSITY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`${styles.densityBtn}${selectedDensity === opt.value ? ` ${styles.active}` : ''}`}
              onClick={() => setSelectedDensity(opt.value)}
            >
              <span className={styles.densityBtnLabel}>{opt.label}</span>
              <span className={styles.densityBtnDesc}>{opt.desc}</span>
            </button>
          ))}
        </div>

        <div className={styles.densityActions}>
          <button
            className={styles.fontBtn}
            onClick={handleInstall}
            disabled={installing}
          >
            {installing ? 'Installing...' : status?.installed ? 'Re-install' : 'Install'}
          </button>
          {status?.installed && (
            <button
              className={styles.fontBtn}
              onClick={handleUninstall}
              disabled={uninstalling}
            >
              {uninstalling ? 'Removing...' : 'Uninstall'}
            </button>
          )}
        </div>

        <div className={styles.densityStatus}>
          <span
            className={`${styles.hookStatusDot}${status?.installed ? ` ${styles.installed}` : ''}`}
          />
          {status?.installed ? (
            <span>
              Installed: <strong>{status.density}</strong> ({status.events.length} events)
            </span>
          ) : (
            <span>Not installed</span>
          )}
        </div>

        {error && (
          <div style={{ color: 'var(--accent-red)', fontSize: '11px', marginTop: '8px' }}>
            {error}
          </div>
        )}
      </div>

      {/* Queue Settings */}
      <div className={styles.section}>
        <h4>Queue</h4>
        <label className={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={autoSendQueue}
            onChange={(e) => setAutoSendQueue(e.target.checked)}
          />
          <span className={styles.toggleSwitch} />
          <span>Auto-send queued prompts when session becomes idle</span>
        </label>
      </div>

      {/* Default Terminal Theme */}
      <div className={styles.section}>
        <h4>Default Terminal Theme</h4>
        <select
          style={{
            width: '100%',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-accent)',
            color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            padding: '6px 10px',
            borderRadius: '4px',
            outline: 'none',
            cursor: 'pointer',
          }}
          value={defaultTerminalTheme}
          onChange={(e) => setDefaultTerminalTheme(e.target.value)}
        >
          <option value="auto">Auto (match dashboard)</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
          <option value="solarized-dark">Solarized Dark</option>
          <option value="solarized-light">Solarized Light</option>
          <option value="dracula">Dracula</option>
          <option value="monokai">Monokai</option>
        </select>
      </div>
    </div>
  );
}
