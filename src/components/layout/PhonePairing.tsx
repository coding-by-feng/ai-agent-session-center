/**
 * PhonePairing — "Pair a phone" inside the device panel (AASC-15).
 *
 * Shows a QR (the https://aasc.work/pair#… link; the codes ride in the
 * fragment, which no server ever receives), the code in text for typing, and a
 * countdown. A phone that redeems the code appears as PENDING with a 6-digit
 * confirmation code: approve only when the phone shows the same digits — that
 * is what stops a second phone that scanned the same QR.
 *
 * Desktop only: the routes answer the AASC page on this machine and nothing
 * else, so the section renders only when this device is local.
 *
 * Until the phone app ships, the Mac doesn't offer pairing (AASC-30): no Pair
 * button, and no section at all unless phones were paired before, which still
 * list here with Allow / Revoke.
 *
 * The QR carries the Mac's code only: an approved phone gets its backend code
 * for notifications over its own session (AASC-52). Backend phone devices this
 * Mac made that no paired phone holds any more get one line and a "Remove them"
 * action. That check calls the cloud, so it runs when the panel opens and once
 * a minute, not on the 2-second refresh.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Button from '@/components/ui/Button';
import { showToast } from '@/components/ui/ToastContainer';
import { qrSvg } from '@/lib/qrSvg';
import {
  approvePhone, formatConfirmCode, formatPairingCode, loadCloudPhones, loadPhonePairing, removePhone,
  removeUnlinkedCloudPhones, startPhonePairing, type PairedPhone, type PhonePairing as Pairing,
} from '@/lib/mobilePairingApi';
import styles from '@/styles/modules/PhonePairing.module.css';

/** How often the list refreshes while the panel is open. */
const POLL_MS = 2000;
/** How often the cloud is asked about leftover phone devices (each check lists the account's devices). */
const CLOUD_POLL_MS = 60_000;

/** Every paired phone has the same, narrower set than a password sign-in (server/mobile/phoneProfile.ts). */
const ACCESS_LABEL = 'shared sessions only';
const ACCESS_DETAIL =
  'Paired phones can watch and drive shared sessions, start Claude or Codex in a known project, and read files '
  + 'in shared projects. They can’t run other commands, change files or change this Mac’s settings.';

function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function formatCountdown(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function relative(at: number | null): string {
  if (!at) return 'never';
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function cloudLine(n: number): string {
  return n === 1
    ? '1 cloud phone device isn’t linked to a paired phone.'
    : `${n} cloud phone devices aren’t linked to a paired phone.`;
}

function PairingQr({ link }: { link: string }) {
  const qr = useMemo(() => qrSvg(link), [link]);
  return (
    <svg
      className={styles.qr}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="QR code to pair a phone"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} className={styles.qrLight} />
      <path d={qr.path} className={styles.qrDark} />
    </svg>
  );
}

export default function PhonePairing() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [phones, setPhones] = useState<PairedPhone[]>([]);
  /** Null until the Mac says; the Pair button shows only on a clear yes. */
  const [offered, setOffered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  /** Backend phone devices no paired phone holds (AASC-52); 0 with no cloud or when the check fails. */
  const [cloudUnlinked, setCloudUnlinked] = useState(0);
  const [confirmCloud, setConfirmCloud] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);

  const refreshCloud = useCallback(async (signal?: AbortSignal) => {
    try {
      const state = await loadCloudPhones(signal);
      setCloudUnlinked(state.cloud ? state.unlinked : 0);
    } catch {
      // A background check: an unreachable cloud just shows no line.
      if (!signal?.aborted) setCloudUnlinked(0);
    }
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const state = await loadPhonePairing(signal);
      setPhones(state.devices);
      setOffered(state.pairingOffered);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh(controller.signal);
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    void refreshCloud(controller.signal);
    const timer = setInterval(() => void refreshCloud(controller.signal), CLOUD_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refreshCloud]);

  const remaining = pairing ? secondsLeft(pairing.expiresAt, now) : 0;
  const pairingLive = pairing !== null && remaining > 0;

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await startPhonePairing();
      setPairing(next);
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<void>, done: string) => {
    setError(null);
    try {
      await fn();
      showToast(done, 'info', 3000);
      setConfirmRevoke(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveCloud = async () => {
    setCloudBusy(true);
    setError(null);
    try {
      const { removed, failed } = await removeUnlinkedCloudPhones();
      if (removed > 0) showToast(`Removed ${removed} cloud phone ${removed === 1 ? 'device' : 'devices'}`, 'info', 3000);
      if (failed > 0) setError(`${failed} couldn’t be removed. Try again later.`);
      setConfirmCloud(false);
      await refreshCloud();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloudBusy(false);
    }
  };

  const pending = phones.filter((p) => p.status === 'pending');
  const active = phones.filter((p) => p.status === 'active');

  // Not offered and nothing paired or left over: a release without the phone app shows nothing about phones.
  if (offered !== true && phones.length === 0 && !pairingLive && !error && cloudUnlinked === 0) return null;

  return (
    <section className={styles.section} aria-label="Paired phones">
      <div className={styles.head}>
        <span className={styles.title}>Phones</span>
        {offered === true && !pairingLive && (
          <Button size="sm" onClick={handleStart} disabled={busy}>
            {busy ? 'Starting…' : 'Pair a phone'}
          </Button>
        )}
      </div>

      {pairingLive && pairing && (
        <div className={styles.pairing}>
          <PairingQr link={pairing.link} />
          <div className={styles.pairingText}>
            <span className={styles.hint}>Scan with the AASC app, or enter</span>
            <code className={styles.code}>{formatPairingCode(pairing.code)}</code>
            <span className={styles.countdown} aria-live="polite">
              Expires in {formatCountdown(remaining)}
            </span>
            <Button size="sm" variant="quiet" onClick={() => setPairing(null)}>Cancel</Button>
          </div>
        </div>
      )}

      {pending.map((p) => (
        <div key={p.id} className={styles.pending} role="alert">
          <span className={styles.pendingText}>
            Allow <strong>{p.label}</strong> ({p.platform === 'ios' ? 'iPhone' : 'Android'})?
          </span>
          <span className={styles.confirm}>
            Code on the phone: <code>{p.confirmCode ? formatConfirmCode(p.confirmCode) : '—'}</code>
          </span>
          <span className={styles.note}>Allow only if your phone shows the same code.</span>
          <span className={styles.actions}>
            <Button size="sm" variant="primary" onClick={() => act(() => approvePhone(p.id), `${p.label} can now connect`)}>
              Allow
            </Button>
            <Button size="sm" variant="danger" onClick={() => act(() => removePhone(p.id), `${p.label} was refused`)}>
              Deny
            </Button>
          </span>
        </div>
      ))}

      {active.length > 0 && (
        <ul className={styles.list}>
          {active.map((p) => (
            <li key={p.id} className={styles.phone}>
              <span className={styles.phoneIcon} aria-hidden="true">📱</span>
              <span className={styles.phoneMain}>
                <span className={styles.phoneName} title={p.label}>{p.label}</span>
                <span className={styles.phoneMeta}>
                  {p.platform === 'ios' ? 'iPhone' : 'Android'} · {ACCESS_LABEL} · last seen {relative(p.lastSeenAt)}
                </span>
              </span>
              {confirmRevoke === p.id ? (
                <span className={styles.actions}>
                  <Button size="sm" variant="danger" onClick={() => act(() => removePhone(p.id), `${p.label} was revoked`)}>
                    Revoke
                  </Button>
                  <Button size="sm" variant="quiet" onClick={() => setConfirmRevoke(null)}>Keep</Button>
                </span>
              ) : (
                <Button size="sm" variant="quiet" onClick={() => setConfirmRevoke(p.id)}>Revoke…</Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {active.length > 0 && <p className={styles.note}>{ACCESS_DETAIL}</p>}

      {cloudUnlinked > 0 && (
        <div className={styles.cloudLeftover}>
          <span className={styles.cloudText}>{cloudLine(cloudUnlinked)}</span>
          {confirmCloud ? (
            <span className={styles.actions}>
              <Button size="sm" variant="danger" onClick={handleRemoveCloud} disabled={cloudBusy}>
                Remove {cloudUnlinked}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirmCloud(false)} disabled={cloudBusy}>Keep</Button>
            </span>
          ) : (
            <Button size="sm" variant="quiet" onClick={() => setConfirmCloud(true)}>Remove them</Button>
          )}
        </div>
      )}

      {offered === true && active.length === 0 && pending.length === 0 && !pairingLive && (
        <p className={styles.empty}>No phones paired.</p>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
