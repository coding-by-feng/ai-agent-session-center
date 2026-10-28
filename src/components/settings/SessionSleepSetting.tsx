/**
 * SessionSleepSetting — Settings → ADVANCED "Sleep idle sessions" (Oct 28 2026, by request).
 * Off by default. On, a session quiet for the chosen time has its CLI stopped to free memory; the
 * card stays (marked Asleep) and opening it resumes the conversation. Sessions that are pinned,
 * busy, asking, running background shells, holding switched-on queue items, central, or that
 * `--resume` cannot bring back never sleep (server/sessionSleep.ts). This Mac only: any other device
 * gets 404 and sees nothing. Applies at once.
 */
import { useCallback, useEffect, useState } from 'react';
import Select from '@/components/ui/Select';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/Settings.module.css';

const ENDPOINT = '/api/session-sleep-setting';
const CHOICES = [0, 15, 30, 60, 120, 240];

function sleepChoiceLabel(minutes: number): string {
  if (minutes === 0) return 'Off — never';
  if (minutes < 60) return `After ${minutes} min idle`;
  const hours = minutes / 60;
  return `After ${hours} hour${hours === 1 ? '' : 's'} idle`;
}

const OPTIONS = CHOICES.map((m) => ({ value: String(m), label: sleepChoiceLabel(m) }));

export default function SessionSleepSetting() {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(ENDPOINT)
      .then((r) => (r.ok ? (r.json() as Promise<{ idleMinutes?: number }>) : null))
      .then((data) => {
        if (cancelled) return;
        if (data && typeof data.idleMinutes === 'number') setMinutes(data.idleMinutes);
        else setHidden(true);
      })
      .catch(() => { if (!cancelled) setHidden(true); });
    return () => { cancelled = true; };
  }, []);

  const choose = useCallback(async (value: string) => {
    const next = Number(value);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleMinutes: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setMinutes(next);
      showToast(next === 0 ? 'Idle sessions stay awake' : `Idle sessions sleep ${sleepChoiceLabel(next).toLowerCase()}`, 'success');
    } catch {
      showToast('Couldn’t change the sleep setting. Try again.', 'error');
    }
  }, []);

  if (hidden || minutes === null) return null;
  return (
    <div className={styles.section}>
      <h4>Sleep idle sessions</h4>
      <p className={styles.settingsHint}>
        Each idle Claude or Codex session keeps about 250–300 MB in memory. A sleeping session’s CLI is
        stopped and its card kept; open it to resume the conversation. Pinned, busy, queued and central
        sessions never sleep.
      </p>
      <Select
        value={String(minutes)}
        onChange={(v) => void choose(v)}
        options={OPTIONS}
        title="Sleep idle sessions"
        style={{ width: '100%' }}
      />
    </div>
  );
}
