import { useState, useRef, useEffect } from 'react';
import type { LoginResult } from '@/hooks/useAuth';
import styles from '@/styles/modules/Login.module.css';

interface LoginScreenProps {
  onLogin: (password: string) => Promise<LoginResult>;
  /** Seconds left of this address's login block when the page loaded. */
  lockedFor?: number;
}

const SECOND_MS = 1000;

/** "Wrong password · 2 tries left" */
function triesLeftText(n: number): string {
  return `Wrong password · ${n} ${n === 1 ? 'try' : 'tries'} left`;
}

/** 900 000 ms → "15:00" */
function formatWait(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / SECOND_MS));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export default function LoginScreen({ onLogin, lockedFor }: LoginScreenProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  // Blocked after 5 wrong passwords (server/authManager.ts); the server stays the authority.
  const [lockedUntil, setLockedUntil] = useState<number | null>(() => (lockedFor ? Date.now() + lockedFor * SECOND_MS : null));
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const locked = lockedUntil !== null && now < lockedUntil;
  const showHint = lockedUntil !== null || attemptsLeft === 1;

  // One tick a second while blocked; stops itself when the block ends.
  useEffect(() => {
    if (lockedUntil === null) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= lockedUntil) clearInterval(id);
    }, SECOND_MS);
    return () => clearInterval(id);
  }, [lockedUntil]);

  // On load, and again when a block ends.
  useEffect(() => {
    if (!locked) inputRef.current?.focus();
  }, [locked]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (locked) return;
    if (!password) {
      setError('Please enter a password');
      return;
    }

    setSubmitting(true);
    setError('');

    const result = await onLogin(password);
    if (!result.success) {
      if (result.retryAfter) {
        const t = Date.now();
        setNow(t);
        setLockedUntil(t + result.retryAfter * SECOND_MS);
        setAttemptsLeft(null);
      } else if (result.attemptsLeft !== undefined) {
        setAttemptsLeft(result.attemptsLeft);
        setError(triesLeftText(result.attemptsLeft));
      } else {
        setError(result.error ?? 'Authentication failed');
      }
      setPassword('');
      inputRef.current?.focus();
    }
    setSubmitting(false);
  }

  const wait = lockedUntil !== null ? formatWait(lockedUntil - now) : '';

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <h2>AI Agent Session Center</h2>
        <p>Enter password to continue</p>

        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          className={styles.input}
          disabled={submitting || locked}
        />

        {locked ? (
          <div className={styles.lockout}>
            <div role="alert" className={styles.error}>Too many wrong passwords.</div>
            <div className={styles.countdown}>
              Try again in <time>{wait}</time>
            </div>
          </div>
        ) : (
          error && (
            <div role="alert" className={attemptsLeft === 1 ? styles.warning : styles.error}>
              {error}
            </div>
          )
        )}

        {showHint && (
          <div className={styles.hint}>
            Forgot it? On the computer running AASC, run <code>npm run set-password</code>.
          </div>
        )}

        <button type="submit" disabled={submitting || locked} className={styles.btn}>
          {locked ? `Locked (${wait})` : submitting ? 'Authenticating...' : 'Login'}
        </button>
      </form>
    </div>
  );
}
