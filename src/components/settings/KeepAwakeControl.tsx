/**
 * KeepAwakeControl — Settings' "Keep this computer awake" (AASC-16; three choices since Nov 27 2026): Off,
 * While an agent is busy, Always while AASC runs. The choice is the server's, saved in its server-config.json
 * (`GET` / `POST /api/config/keep-awake`), so a server with no window keeps it too; setup asks it first.
 *
 * The route answers this computer only, so a phone, a paired computer or any remote browser gets no answer
 * and this draws nothing. Full shows it under ADVANCED; Lite, which has no ADVANCED tab, under APPEARANCE:
 * "Always" acts on its own, so Lite needs a way to turn it off.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import styles from '@/styles/modules/Settings.module.css';

export type KeepAwakeMode = 'off' | 'busy' | 'always';

const CHOICES: ReadonlyArray<{ mode: KeepAwakeMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'busy', label: 'While an agent is busy' },
  { mode: 'always', label: 'Always, while AASC runs' },
];

const isMode = (v: unknown): v is KeepAwakeMode => v === 'off' || v === 'busy' || v === 'always';

export default function KeepAwakeControl() {
  /** Null until this computer's server answers; stays null on a remote device. */
  const [mode, setMode] = useState<KeepAwakeMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useId();

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/config/keep-awake', { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { data?: { mode?: unknown } };
        if (!controller.signal.aborted && isMode(body.data?.mode)) setMode(body.data.mode);
      })
      .catch(() => { /* an older or unreachable server: show nothing */ });
    return () => controller.abort();
  }, []);

  const choose = useCallback(async (next: KeepAwakeMode) => {
    const previous = mode;
    setMode(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/config/keep-awake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setMode(previous);
      setError('Couldn’t save. Try again.');
    } finally {
      setSaving(false);
    }
  }, [mode]);

  if (mode === null) return null;

  return (
    <fieldset className={styles.keepAwakeSet} aria-busy={saving || undefined}>
      <legend><h4>Keep this computer awake</h4></legend>
      <p className={styles.settingsHint}>
        Stop this computer from sleeping on its own, so your phone and other computers can still reach it and get
        notifications. The screen can still turn off, and a closed laptop on battery may still sleep.
      </p>
      <div className={styles.keepAwakeChoices}>
        {CHOICES.map((c) => (
          <label key={c.mode} className={styles.keepAwakeChoice}>
            <input
              type="radio"
              name={name}
              value={c.mode}
              checked={mode === c.mode}
              disabled={saving}
              onChange={() => { void choose(c.mode); }}
            />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
      {error && <p className={styles.keepAwakeError} role="alert">{error}</p>}
    </fieldset>
  );
}
