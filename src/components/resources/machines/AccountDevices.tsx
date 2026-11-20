/**
 * AccountDevices — RESOURCES → Machines › Devices on your account (plan 18): every device signed in to this
 * computer's AASC Cloud account, with a way to sign one out.
 *
 * Shown only while this computer is connected to AASC Cloud, by the status the RESOURCES tab already reads
 * (`useCloudSession`): a computer that is not signed in shows no account UI at all (AASC-64). The list comes from
 * this computer's own server (`GET /api/resources/cloud/account/devices`), already ordered: this computer first,
 * then most recently used.
 *
 * Read when Machines becomes the tab in front (MachinesPanel stays mounted, hidden), when a sign-out request
 * ends (whatever came of it: the list says what is true now), and on Check again; never on a timer. One read at a
 * time: a new one cancels the one that is out, so a list read before a sign-out can never bring the signed-out
 * device back. A refresh that fails keeps the rows and says they may be out of date (`StaleNote`); with nothing to
 * show, the state gets one line and at most one action.
 *
 * A table when the section is wide; at 720px and under (a container query, so it follows the section, not the
 * window) each row becomes a card.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import SectionHeader from '@/components/ui/SectionHeader';
import StaleNote from '@/components/ui/StaleNote';
import { useCloudSession } from '@/components/resources/cloud/cloudSession';
import { CloudApiError, cloudApi, type AccountDevice } from '@/lib/cloudApi';
import res from '@/styles/modules/Resources.module.css';
import styles from '@/styles/modules/AccountDevices.module.css';
import AccountDeviceRow from './AccountDeviceRow';

const TITLE = 'Devices on your account';
const NEEDS_SIGN_IN = 'This computer signed in before devices could be listed. Sign out of AASC Cloud and sign in again.';
const UNREACHABLE = 'Can’t reach AASC Cloud.';
const LIST_FAILED = 'Couldn’t list the devices on your account.';

type View =
  | { kind: 'loading' }
  /** The server says this computer is not connected after all: nothing to show. */
  | { kind: 'hidden' }
  | { kind: 'needs-sign-in' }
  | { kind: 'unreachable' }
  | { kind: 'failed'; message: string }
  /** `stale`: the last refresh failed, and these are the rows from before it. */
  | { kind: 'ready'; devices: AccountDevice[]; stale: boolean };

async function readList(signal: AbortSignal): Promise<View> {
  try {
    const { devices } = await cloudApi.accountDevices(signal);
    return { kind: 'ready', devices, stale: false };
  } catch (err) {
    if (!(err instanceof CloudApiError)) return { kind: 'failed', message: LIST_FAILED };
    if (err.code === 'not_connected') return { kind: 'hidden' };
    if (err.code === 'needs_sign_in') return { kind: 'needs-sign-in' };
    if (err.code === 'cloud_unavailable') return { kind: 'unreachable' };
    return { kind: 'failed', message: err.message };
  }
}

/** A failed refresh keeps the rows it could not replace. */
function after(old: View, next: View): View {
  const failed = next.kind === 'unreachable' || next.kind === 'failed';
  return failed && old.kind === 'ready' ? { ...old, stale: true } : next;
}

export default function AccountDevices({ open, onAccount }: {
  /** Machines is the open RESOURCES tab. */
  open: boolean;
  /** Open the cloud account dialog. */
  onAccount: () => void;
}) {
  const { status, loaded } = useCloudSession();
  const connected = loaded && status.connection !== null && (status.state === 'connected' || status.state === 'offline');
  if (!connected || status.connection === null) return null;
  // Another account is another list: the key starts the section afresh. A newer connection to the same account
  // (signing in again) is the same list, and a row that is asking keeps its question.
  const account = `${status.connection.backendOrigin} ${status.connection.accountId}`;
  return <DevicesSection key={account} open={open} onAccount={onAccount} />;
}

function DevicesSection({ open, onAccount }: { open: boolean; onAccount: () => void }) {
  const { refresh } = useCloudSession();
  const [view, setView] = useState<View>({ kind: 'loading' });
  /** A read the person asked for (Check again, Retry) is out. */
  const [checking, setChecking] = useState(false);
  const request = useRef<AbortController | null>(null);
  const headRef = useRef<HTMLDivElement>(null);
  /** Machines is the tab in front: a sign-out that ends after it is left reads nothing (the next opening does). */
  const inFront = useRef(false);

  /** Read the list, in place of any read that is out. */
  const load = useCallback(() => {
    request.current?.abort();
    const cut = new AbortController();
    request.current = cut;
    void readList(cut.signal).then((next) => {
      if (cut.signal.aborted) return;
      request.current = null;
      setChecking(false);
      setView((old) => after(old, next));
    });
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    inFront.current = true;
    load();
    return () => {
      inFront.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [open, load]);

  /** Check again / Retry: one at a time. */
  const check = () => {
    if (request.current) return;
    setChecking(true);
    load();
  };

  /** A sign-out request ended, in a refusal too: the list is read again. */
  const settled = () => {
    if (inFront.current) load();
  };

  /** The row goes at once; the read its request's end started confirms it. */
  const signedOut = (id: string) => {
    setView((old) => (old.kind === 'ready' ? { ...old, devices: old.devices.filter((d) => d.id !== id) } : old));
  };

  if (view.kind === 'hidden') return null;

  return (
    <section aria-label={TITLE} className={styles.section}>
      {/* The control sits beside the heading, not in it: inside, its words would become part of the heading's name. */}
      <div ref={headRef} tabIndex={-1} className={styles.head}>
        <SectionHeader label={TITLE} level={2} className={styles.heading} />
        {view.kind === 'ready' && (
          <span className={styles.headAside}>
            {checking && <span role="status">Checking…</span>}
            <Button size="sm" aria-busy={checking || undefined} onClick={check}>Check again</Button>
          </span>
        )}
      </div>

      {view.kind === 'loading' && <p className={styles.line} role="status">Checking…</p>}

      {view.kind === 'needs-sign-in' && (
        <div className={styles.notice}>
          <span className={styles.noticeText}>{NEEDS_SIGN_IN}</span>
          <Button size="sm" onClick={onAccount}>Open cloud account</Button>
        </div>
      )}

      {(view.kind === 'unreachable' || view.kind === 'failed') && (
        <div className={styles.notice}>
          {checking
            ? <span className={styles.noticeText} role="status">Checking…</span>
            : view.kind === 'failed'
              ? <span className={`${styles.noticeText} ${styles.error}`} role="alert">{view.message}</span>
              : <span className={styles.noticeText}>{UNREACHABLE}</span>}
          <Button size="sm" aria-busy={checking || undefined} onClick={check}>Retry</Button>
        </div>
      )}

      {view.kind === 'ready' && (
        <>
          {view.stale && <StaleNote onRetry={check} />}
          {/* A list with no row it could read draws no empty table: the heading and Check again stand alone. */}
          <div className={styles.frame} hidden={view.devices.length === 0}>
            <table role="table" aria-label={TITLE} className={styles.table}>
              <thead role="rowgroup">
                <tr role="row">
                  <th scope="col" role="columnheader">Name</th>
                  <th scope="col" role="columnheader">Kind</th>
                  <th scope="col" role="columnheader">Last used</th>
                  <th scope="col" role="columnheader"><span className={res.visuallyHidden}>Actions</span></th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {view.devices.map((device) => (
                  <AccountDeviceRow key={device.id} device={device} fallbackFocus={headRef} onSignedOut={signedOut} onStale={refresh} onSettled={settled} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
