import { useState } from 'react';
import Button from '@/components/ui/Button';
import { hostedParent } from '@/lib/hosted';
import styles from './hosted.module.css';

interface Credentials {
  deviceId: string;
  deviceToken: string;
  confirmCode: string;
}
const KEY = 'aasc-hosted-phone';
function saved(): Credentials | null {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
  } catch {
    return null;
  }
}
async function post(path: string, body: unknown) {
  const response = await fetch(`/api/mobile/${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? 'Pairing failed. Ask the order owner for a fresh link.');
  return data.data;
}
export default function HostedPhonePair() {
  const [credentials, setCredentials] = useState<Credentials | null>(saved);
  const [code] = useState(() => {
    const value = window.location.hash.slice(1);
    // The one-use code never goes to the HTTP server in a URL or remains in browser history.
    window.history.replaceState(null, '', '/hosted/pair');
    return value;
  });
  const [label, setLabel] = useState('My phone browser');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true);
    setError('');
    try {
      if (!credentials) {
        if (!/^[A-Z2-9]{10}$/.test(code))
          throw new Error('Pairing link is missing or invalid. Ask the owner for a new link.');
        const paired = await post('pair', {
          code,
          label,
          platform: /Android/i.test(navigator.userAgent) ? 'android' : 'ios',
        });
        const next = {
          deviceId: paired.deviceId,
          deviceToken: paired.deviceToken,
          confirmCode: paired.confirmCode,
        };
        sessionStorage.setItem(KEY, JSON.stringify(next));
        setCredentials(next);
      } else {
        const { nonce } = await post('challenge', { deviceId: credentials.deviceId });
        if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
          throw new Error('Invalid device challenge.');
        const encoder = new TextEncoder();
        const hash = await crypto.subtle.digest('SHA-256', encoder.encode(credentials.deviceToken));
        const key = await crypto.subtle.importKey(
          'raw',
          hash,
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign'],
        );
        const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(nonce));
        const proof = Array.from(new Uint8Array(signature), (byte) =>
          byte.toString(16).padStart(2, '0'),
        ).join('');
        await post('session', { deviceId: credentials.deviceId, nonce, proof });
        window.location.replace('/');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!hostedParent()) return <p>Hosted phone pairing is unavailable on this server.</p>;
  return (
    <section className={styles.error}>
      <h2>Connect this phone browser</h2>
      {credentials ? (
        <>
          <p>Compare this code with the order owner’s workspace:</p>
          <h2>{credentials.confirmCode}</h2>
          <p>
            After the owner approves this phone, tap Connect. This phone gets access to shared
            sessions only.
          </p>
        </>
      ) : (
        <>
          <p>
            This is browser pairing. The native phone app does not support hosted HTTPS runtimes
            yet.
          </p>
          <label>
            Phone name{' '}
            <input
              value={label}
              maxLength={80}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      <Button disabled={busy} onClick={() => void connect()}>
        {busy ? 'Connecting…' : credentials ? 'Connect after approval' : 'Request pairing'}
      </Button>
      <p>
        The pairing key stays in this browser tab’s session storage. Keep the tab open; a new tab
        needs a new pairing link.
      </p>
      {credentials && (
        <Button
          onClick={() => {
            sessionStorage.removeItem(KEY);
            setCredentials(null);
            setError('Ask the owner for a new pairing link.');
          }}
        >
          Forget this browser key
        </Button>
      )}
    </section>
  );
}
