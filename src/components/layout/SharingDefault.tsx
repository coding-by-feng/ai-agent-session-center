/**
 * SharingDefault — "Share new sessions with my devices" in the Mac's devices panel (Oct 2026,
 * by request). On, every session that appears on this Mac starts shared, so the person needn't
 * press 📡 SHARE on each; 📡 still hides one, and a restored session keeps its saved choice.
 * "Share all open sessions now" covers the ones already running. Mac only: the routes answer
 * 404 to any other device (server/shareDefault.ts, apiRouter).
 */
import { useCallback, useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/SharingDefault.module.css';

const SWITCH_LABEL = 'Share new sessions with my devices';

export default function SharingDefault() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/sharing-default')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { shareNewSessions?: boolean } | null) => { if (!cancelled) setOn(data?.shareNewSessions === true); })
      .catch(() => { if (!cancelled) setOn(false); });
    return () => { cancelled = true; };
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch('/api/sharing-default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareNewSessions: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setOn(next);
      showToast(next ? 'New sessions will be shared with your devices' : 'New sessions stay on this Mac until you share them', 'success');
    } catch {
      showToast('Couldn’t change the sharing setting. Try again.', 'error');
    } finally {
      setBusy(false);
    }
  }, []);

  const shareAll = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/sessions/share-all', { method: 'POST' });
      const data = (await res.json().catch(() => null)) as { shared?: number } | null;
      if (!res.ok) throw new Error(String(res.status));
      const n = data?.shared ?? 0;
      showToast(n === 0 ? 'Every open session is already shared' : `Shared ${n} open session${n === 1 ? '' : 's'} with your devices`, 'success');
    } catch {
      showToast('Couldn’t share the open sessions. Try again.', 'error');
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className={styles.section} aria-label="Sharing">
      <span className={styles.title}>Sharing</span>
      <label className={styles.row}>
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          checked={on === true}
          disabled={on === null || busy}
          onChange={(e) => void toggle(e.target.checked)}
          aria-label={SWITCH_LABEL}
        />
        <span className={styles.label}>{SWITCH_LABEL}</span>
      </label>
      <p className={styles.hint}>
        New sessions show on your phones and other signed-in devices at once. 📡 on a session still hides it.
      </p>
      <div>
        <Button size="sm" onClick={() => void shareAll()} disabled={busy}>Share all open sessions now</Button>
      </div>
    </section>
  );
}
