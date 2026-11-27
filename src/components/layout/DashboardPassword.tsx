/**
 * DashboardPassword — set or change this computer's dashboard password from the devices panel
 * (Nov 27 2026). Phones and other computers can't connect to a computer without one (remote access
 * is refused, and nothing is listed on the account), and the panel used to say only "run
 * `npm run set-password`", which needs a code checkout a packaged app doesn't have.
 *
 * Shown only on this computer (the panel's own `canPairPhones` part); the route answers 403 to any
 * other device anyway (server/authPassword.ts). Setting the first password signs this window in;
 * changing it keeps this window signed in, signs out every other browser that used the old one, and
 * unpairs every phone and computer (their credentials belong to the old password), which the form says.
 * Either way the session's refresh is handed to `useAuth` through `AUTH_SESSION_EVENT`.
 */
import { useCallback, useEffect, useId, useState, type ChangeEvent, type FormEvent } from 'react';
import Button from '@/components/ui/Button';
import TextInput from '@/components/ui/TextInput';
import { showToast } from '@/components/ui/ToastContainer';
import { authFetch, AUTH_SESSION_EVENT } from '@/hooks/useAuth';
import styles from '@/styles/modules/DashboardPassword.module.css';

/** The server's rule (validatePasswordComplexity), said before the first try. */
const RULE = 'At least 8 characters, with an uppercase and a lowercase letter, a digit and a symbol.';

type Fields = { current: string; next: string; confirm: string };
const EMPTY: Fields = { current: '', next: '', confirm: '' };

async function readEnabled(signal: AbortSignal): Promise<boolean | null> {
  const res = await fetch('/api/auth/status', { signal });
  if (!res.ok) return null;
  const data = (await res.json()) as { passwordRequired?: unknown };
  return typeof data.passwordRequired === 'boolean' ? data.passwordRequired : null;
}

export default function DashboardPassword() {
  /** Null until the server says (or when it can't), and nothing shows. */
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = useId();

  useEffect(() => {
    const controller = new AbortController();
    readEnabled(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setEnabled(value); },
      () => { if (!controller.signal.aborted) setEnabled(null); },
    );
    return () => controller.abort();
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setFields(EMPTY);
    setError(null);
  }, []);

  const submit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (fields.next !== fields.confirm) {
      setError('The two new passwords don’t match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch('/api/auth/password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(enabled ? { current: fields.current, password: fields.next } : { password: fields.next }),
      });
      const data = (await res.json().catch(() => null)) as { success?: boolean; error?: string; expiresIn?: number } | null;
      if (!res.ok || !data?.success) {
        setError(data?.error ?? 'Couldn’t save the password. Try again.');
        return;
      }
      document.dispatchEvent(new CustomEvent(AUTH_SESSION_EVENT, { detail: { expiresIn: data.expiresIn } }));
      showToast(enabled ? 'Password changed. Pair your phones and computers again.' : 'Password set. Phones and other computers can connect now.', 'success');
      setEnabled(true);
      close();
    } catch {
      setError('Couldn’t reach this computer’s server. Try again.');
    } finally {
      setBusy(false);
    }
  }, [enabled, fields, close]);

  if (enabled === null) return null;

  const set = (key: keyof Fields) => (e: ChangeEvent<HTMLInputElement>) => setFields((f) => ({ ...f, [key]: e.target.value }));

  return (
    <section className={styles.section} aria-label="Dashboard password">
      <div className={styles.head}>
        <span className={styles.title}>Dashboard password</span>
        {/* Off says itself once, in the warning line (or the open form); On needs saying here. */}
        <span className={styles.on}>{enabled ? 'On' : ''}</span>
        {!open && (
          <Button size="sm" variant={enabled ? 'quiet' : 'default'} onClick={() => setOpen(true)}>
            {enabled ? 'Change password…' : 'Set password…'}
          </Button>
        )}
      </div>
      {!enabled && !open && (
        <p className={styles.warn}>Phones and other computers can’t connect until you set one.</p>
      )}
      {open && (
        <form className={styles.form} onSubmit={submit} aria-describedby={`${id}-rule`}>
          {enabled && (
            <label className={styles.field}>
              <span className={styles.label}>Current password</span>
              <TextInput type="password" autoComplete="current-password" value={fields.current} onChange={set('current')} required autoFocus />
            </label>
          )}
          <label className={styles.field}>
            <span className={styles.label}>New password</span>
            <TextInput type="password" autoComplete="new-password" value={fields.next} onChange={set('next')} required autoFocus={!enabled} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Confirm new password</span>
            <TextInput type="password" autoComplete="new-password" value={fields.confirm} onChange={set('confirm')} required />
          </label>
          <p id={`${id}-rule`} className={styles.hint}>
            {RULE} {enabled
              ? 'Changing it unpairs every phone and computer: pair them again afterwards. This window stays signed in.'
              : 'This computer stays signed in. Phones and other computers will ask for it.'}
          </p>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <div className={styles.actions}>
            <Button size="sm" variant="quiet" type="button" onClick={close} disabled={busy}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit" disabled={busy || !fields.next || !fields.confirm || (enabled && !fields.current)}>
              {busy ? 'Saving…' : enabled ? 'Change' : 'Set password'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
