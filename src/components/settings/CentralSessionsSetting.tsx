/**
 * CentralSessionsSetting — Settings → ADVANCED "Central sessions (MCP)" (Oct 28 2026, by request).
 * Off by default: no `/mcp` endpoint, no `aasc` MCP server on any launch, no Central picker. The
 * choice is saved at once and applies the next time AASC starts (server/mcp/runtime.ts), so the
 * section says when a restart is still owed. This Mac only: any other device gets 404 and sees nothing.
 */
import { useCallback, useEffect, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/Settings.module.css';

interface CentralSetting {
  enabled: boolean;
  nextStart: boolean;
}

const ENDPOINT = '/api/central-sessions-setting';

export default function CentralSessionsSetting() {
  const [setting, setSetting] = useState<CentralSetting | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(ENDPOINT)
      .then((r) => (r.ok ? (r.json() as Promise<CentralSetting>) : null))
      .then((data) => {
        if (cancelled) return;
        if (data) setSetting({ enabled: data.enabled === true, nextStart: data.nextStart === true });
        else setHidden(true);
      })
      .catch(() => { if (!cancelled) setHidden(true); });
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as CentralSetting;
      setSetting({ enabled: data.enabled === true, nextStart: data.nextStart === true });
      showToast(next ? 'Central sessions turn on when AASC restarts' : 'Central sessions turn off when AASC restarts', 'success');
    } catch {
      showToast('Couldn’t change the central-sessions setting. Try again.', 'error');
    } finally {
      setBusy(false);
    }
  }, []);

  if (hidden) return null;
  const restartOwed = setting !== null && setting.enabled !== setting.nextStart;
  return (
    <div className={styles.section}>
      <h4>Central sessions (MCP)</h4>
      <p className={styles.settingsHint}>
        A central session gets AASC’s own MCP server, so it can see and drive your other sessions. Off by
        default: it adds a background runtime most setups never use.
      </p>
      <label className={styles.toggleLabel}>
        <input
          type="checkbox"
          checked={setting?.nextStart === true}
          disabled={setting === null || busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span className={styles.toggleSwitch} />
        <span>Enable central sessions and the /mcp server</span>
      </label>
      {restartOwed && (
        <p className={styles.settingsHint} role="status">
          Restart AASC to {setting.nextStart ? 'turn them on' : 'turn them off'}.
        </p>
      )}
    </div>
  );
}
