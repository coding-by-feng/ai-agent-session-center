import { useHostedControls } from './HostedConnectionMenu';
import { useSessionStore } from '@/stores/sessionStore';
import { useEffect, useRef, useState } from 'react';
import { useWsStore } from '@/stores/wsStore';
import Button from '@/components/ui/Button';
import { qrSvg } from '@/lib/qrSvg';
import styles from './hosted.module.css';
import { hostedParent } from '@/lib/hosted';
async function api(path: string, method = 'GET') {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(method !== 'GET' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? 'Connection failed. Try again.'), { status: response.status });
  return body;
}
interface Phone {
  id: string;
  label: string;
  status: string;
  confirmCode: string | null;
}
function PhoneManager({ close }: { close: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const panel = dialog.current;
    panel?.showModal();
    return () => panel?.close();
  }, []);
  const [phones, setPhones] = useState<Phone[]>([]);
  const [pair, setPair] = useState<{ link: string; expiresAt: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let active = true;
    const update = () => {
      void api('/api/hosted/phones')
        .then((data) => {
          if (active) {
            setPhones(data.devices);
            setNow(Date.now());
          }
        })
        .catch((err) => {
          if (active) setError(err.message);
        });
    };
    update();
    const timer = setInterval(update, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function run(path: string, method = 'POST') {
    setBusy(true);
    setError('');
    try {
      const result = await api(path, method);
      if (result.link) setPair(result);
      setPhones((await api('/api/hosted/phones')).devices);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const qr = pair && pair.expiresAt > now ? qrSvg(pair.link) : null;
  return (
    <dialog
      ref={dialog}
      aria-labelledby="hosted-pair-title"
      className={styles.panel}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2 id="hosted-pair-title">Connect a phone browser</h2>
      <p>
        Scan with your phone camera and open in its browser. The native phone app does not support
        this hosted HTTPS address yet.
      </p>
      <p>
        Each link works once for 10 minutes. Compare the six-digit code on both screens before
        approving.
      </p>
      <Button disabled={busy} onClick={() => void run('/api/hosted/phones/pairing')}>
        Create pairing link
      </Button>
      {pair && (
        <div>
          {qr ? (
            <>
              <svg
                role="img"
                aria-label="Phone browser pairing QR code"
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                className={styles.qr}
              >
                <rect width={qr.size} height={qr.size} fill="white" />
                <path d={qr.path} fill="black" />
              </svg>
              <p>
                <a href={pair.link} target="_blank" rel="noreferrer">
                  Open phone pairing link
                </a>
              </p>
            </>
          ) : (
            <p>Pairing link expired. Create a new one.</p>
          )}
        </div>
      )}
      {phones.length === 0 && <p>No paired phones yet.</p>}
      {phones.map((phone) => (
        <div key={phone.id} className={styles.phone}>
          <strong>{phone.label}</strong>
          <span>
            {phone.status === 'pending' ? `Compare code: ${phone.confirmCode}` : phone.status}
          </span>
          {phone.status === 'pending' && (
            <Button
              disabled={busy}
              onClick={() => void run(`/api/hosted/phones/${phone.id}/approve`)}
            >
              Codes match — approve
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={() => void run(`/api/hosted/phones/${phone.id}`, 'DELETE')}
          >
            {phone.status === 'pending' ? 'Deny' : 'Revoke'}
          </Button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
      <Button onClick={close}>Close</Button>
    </dialog>
  );
}
export default function HostedWorkspace({ needsLogin }: { needsLogin: boolean }) {
  const parent = hostedParent();
  const connected = useWsStore((s) => s.connected);
  const snapshot = useWsStore((s) => s.snapshotReceived);
  const [owner, setOwner] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [setupAttempt, setSetupAttempt] = useState(0);
  const sent = useRef(false);
  const selectedDefault = useRef(false);
  useEffect(() => {
    if (!parent) return;
    let expanded = false;
    const escape = (event: KeyboardEvent) => {
      if (expanded && event.key === 'Escape') {
        window.parent.postMessage({ type: 'aasc:hosted-exit-expanded' }, parent);
      }
    };
    const receive = (event: MessageEvent) => {
      if (event.origin === parent && event.source === window.parent && event.data?.type === 'aasc:hosted-expanded') {
        expanded = event.data.expanded === true;
        return;
      }
      if (
        event.origin !== parent ||
        event.source !== window.parent ||
        event.data?.type !== 'aasc:hosted-logout'
      )
        return;
      void fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
      })
        .then((response) => {
          if (!response.ok) throw new Error('Sign out failed');
          window.parent.postMessage({ type: 'aasc:hosted-logged-out' }, parent);
          window.location.replace('/');
        })
        .catch(() => window.parent.postMessage({ type: 'aasc:hosted-error', reason: 'logout_failed' }, parent));
    };
    window.addEventListener('message', receive);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('message', receive);
      window.removeEventListener('keydown', escape);
    };
  }, [parent]);
  useEffect(() => {
    if (!parent) return;
    if (needsLogin) {
      window.parent.postMessage({ type: 'aasc:hosted-error', reason: window.parent !== window ? 'embedded_auth' : 'auth_required' }, parent);
      return;
    }
    let active = true;
    void (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await api('/api/hosted/status'); }
        catch (err) {
          const status = (err as {status?:number}).status;
          if (!active || attempt >= 2 || status === 401 || status === 403) throw err;
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    })()
      .then((data) => {
        if (!active) return;
        setAuthenticated(true);
        setOwner(data.owner === true);
        if (data.owner && new URLSearchParams(window.location.search).get('hostedPair') === '1')
          setPairing(true);
      })
      .catch((err) => {
        if (active) {
          setError(err.message);
          window.parent.postMessage({ type: 'aasc:hosted-error', reason: err.status === 401 ? (window.parent !== window ? 'embedded_auth' : 'auth_required') : err.status === 403 ? 'access_denied' : 'network' }, parent);
        }
      });
    return () => {
      active = false;
    };
  }, [parent, needsLogin]);
  useEffect(() => {
    if (parent && authenticated && connected && snapshot && !sent.current) {
      sent.current = true;
      window.parent.postMessage({ type: 'aasc:hosted-ready' }, parent);
    }
  }, [parent, authenticated, connected, snapshot]);
  useEffect(() => {
    if (!authenticated || !owner || !connected || !snapshot) return;
    let active = true;
    setSetupError('');
    void api('/api/hosted/default-sessions', 'POST').then(data => {
      if (active && !selectedDefault.current && typeof data.sessions?.claude === 'string') {
        selectedDefault.current = true;
        useSessionStore.getState().selectSession(data.sessions.claude);
      }
    }).catch(() => { if (active) setSetupError('Claude / Codex 会话启动失败。终端连接仍可使用。'); });
    return () => { active = false; };
  }, [authenticated, owner, connected, snapshot, setupAttempt]);
  useEffect(() => {
    useHostedControls.setState({ pair: authenticated && owner && !needsLogin ? () => setPairing(true) : null });
    return () => { useHostedControls.setState({ pair: null }); };
  }, [authenticated, owner, needsLogin]);
  if (!parent) return null;
  if (needsLogin || error)
    return (
      <div className={styles.error} role="alert">
        <h2>Reconnect your workspace</h2>
        <p>
          {error ||
            'Your session is unavailable. Open the order again. If your browser blocks embedded cookies, allow cookies for this workspace and retry.'}
        </p>
        <a href={parent} target="_top">
          Open xclaude.dev
        </a>
      </div>
    );
  return (
    <>
      {setupError && <div role="alert">{setupError} <Button onClick={() => setSetupAttempt(n => n + 1)}>重试启动</Button></div>}
      {pairing && <PhoneManager close={() => setPairing(false)} />}
    </>
  );
}
