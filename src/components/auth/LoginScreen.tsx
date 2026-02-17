import { useState, useRef, useEffect } from 'react';
import styles from '@/styles/modules/Login.module.css';

interface LoginScreenProps {
  onLogin: (password: string) => Promise<{ success: boolean; error?: string }>;
}

export default function LoginScreen({ onLogin }: LoginScreenProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setError('Please enter a password');
      return;
    }

    setSubmitting(true);
    setError('');

    const result = await onLogin(password);
    if (!result.success) {
      setError(result.error ?? 'Authentication failed');
      setPassword('');
      inputRef.current?.focus();
    }
    setSubmitting(false);
  }

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
          disabled={submitting}
        />

        {error && <p className={styles.error}>{error}</p>}

        <button type="submit" disabled={submitting} className={styles.btn}>
          {submitting ? 'Authenticating...' : 'Login'}
        </button>
      </form>
    </div>
  );
}
