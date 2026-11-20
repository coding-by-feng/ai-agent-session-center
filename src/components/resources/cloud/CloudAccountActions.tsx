/**
 * CloudAccountActions — "Your account" under the device connection (plan 18), for an account this
 * Mac joined with Google sign-in.
 *
 *   Export my data    saves what AASC Cloud holds for the account to a file on this computer.
 *   Delete account…   asks here first, then opens the browser: the backend's page names the
 *                     account and only its button deletes. This card waits and reads how it ended.
 *
 * It sits inside the cloud account dialog, so the confirmation is inline: the shared Modal shows
 * one dialog at a time. The message after a delete outlives the account block, which goes away
 * with the connection.
 */
import { useEffect, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import { cloudApi, type BrowserStepResult } from '@/lib/cloudApi';
import type { CloudStatus } from '@/types/cloud';
import { useCloudAction, useCloudSession } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';

/** While the browser step runs, the card asks the Mac this often how it stands. */
const POLL_MS = 2_000;
/** = the Mac's SIGN_IN_PENDING_MS: after this the Mac has dropped the browser step anyway. */
const WAIT_MS = 600_000;
/**
 * The backend deletes on its own page's button, whatever this card is doing. So when this computer
 * stops waiting, or never sees the return, it must not claim that nothing happened.
 */
const NOT_SEEN =
  'This computer did not see the delete finish. If you pressed Delete in the browser, the account is gone: refresh the connection to check.';
const STOPPED_WAITING = 'Stopped waiting. Close the browser tab too: its Delete button still works.';

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function resultText(result: BrowserStepResult, email: string): string {
  if (result === 'deleted') return 'Your AASC Cloud account was deleted.';
  if (result === 'deleted-other')
    return `A different Google account was deleted. This computer is still signed in as ${email}.`;
  if (result === 'deleted-unchecked')
    return 'The account you chose was deleted. This computer could not check its own connection: refresh the connection.';
  return NOT_SEEN;
}

export default function CloudAccountActions({ onStatus }: { onStatus: (s: CloudStatus) => void }) {
  const session = useCloudSession(),
    action = useCloudAction();
  const email = session.status.connection?.accountEmail ?? null;
  const [saved, setSaved] = useState<{ path: string; bytes: number } | null>(null),
    [confirming, setConfirming] = useState(false),
    [waiting, setWaiting] = useState(false),
    [notice, setNotice] = useState<string | null>(null);
  // The address the delete was started for: the block can be gone by the time the answer arrives.
  const startedFor = useRef('');
  // The status read after a delete must outlive the wait: ending the wait re-runs the effect
  // below, and its cleanup would abort a read that shared its controller.
  const unmounted = useRef<AbortController | null>(null);
  useEffect(() => {
    const cut = new AbortController();
    unmounted.current = cut;
    return () => cut.abort();
  }, []);
  useEffect(() => {
    if (!waiting) return;
    const cut = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One question at a time: the next is asked only after the last was answered.
    const ask = () => {
      timer = setTimeout(async () => {
        if (cut.signal.aborted) return;
        if (Date.now() - started >= WAIT_MS) {
          setWaiting(false);
          setNotice(NOT_SEEN);
          return;
        }
        let state: Awaited<ReturnType<typeof cloudApi.googleState>> | null = null;
        try {
          state = await cloudApi.googleState(cut.signal);
        } catch {
          state = null;
        }
        if (cut.signal.aborted) return;
        if (!state || state.pending) return ask();
        setWaiting(false);
        // Dropped without an answer (cancelled from another window): nothing to say.
        if (state.last?.intent !== 'delete') return;
        setNotice(resultText(state.last.result, startedFor.current));
        // The Mac has already forgotten a deleted account's connection: show that.
        if (state.last.result === 'deleted')
          void cloudApi
            .status(unmounted.current?.signal)
            .then(onStatus)
            .catch(() => {});
      }, POLL_MS);
    };
    ask();
    return () => {
      clearTimeout(timer);
      cut.abort();
    };
    // `onStatus` only forwards the status; the poll restarts on `waiting` alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);
  function exportData() {
    setSaved(null);
    setNotice(null);
    action.run((binding, signal) => cloudApi.accountExport(binding, signal), setSaved);
  }
  function continueInBrowser() {
    setNotice(null);
    startedFor.current = email ?? '';
    action.run(
      (binding, signal) => cloudApi.googleStart({ intent: 'delete' }, signal, binding),
      ({ url }) => {
        // In the desktop app attachWindowOpenPolicy hands this to the system browser.
        window.open(url, '_blank', 'noopener');
        setConfirming(false);
        setWaiting(true);
      },
    );
  }
  function cancelWaiting() {
    setWaiting(false);
    setNotice(STOPPED_WAITING);
    void cloudApi.googleCancel().catch(() => {});
  }
  if (!email)
    return notice ? (
      <p role="status" className={styles.hint}>
        {notice}
      </p>
    ) : null;
  return (
    <div role="group" aria-label="Your account" className={styles.account}>
      <h4>Your account</h4>
      <p className={styles.hint}>
        Export saves everything AASC Cloud holds for {email} to a file in Downloads.
      </p>
      <div className={styles.toolbar}>
        <Button disabled={action.busy || waiting || !action.enabled} onClick={exportData}>
          Export my data
        </Button>
      </div>
      {saved && (
        <p role="status" className={styles.hint}>
          Saved to {saved.path} ({sizeText(saved.bytes)})
        </p>
      )}
      <div className={styles.accountDanger}>
        {confirming ? (
          <div className={styles.banner}>
            <strong>Delete your AASC Cloud account?</strong>
            <p>
              This removes the account, every device signed in to it, and its synced notes,
              resources and saved projects from AASC Cloud. Sessions and files on your computers are
              not touched.
            </p>
            <p>
              You confirm in your browser, signed in as {email}. Nothing is deleted until you press
              the button there.
            </p>
            <div className={styles.toolbar}>
              <Button onClick={() => setConfirming(false)}>Cancel</Button>
              <Button variant="danger" disabled={action.busy} onClick={continueInBrowser}>
                Continue in browser…
              </Button>
            </div>
          </div>
        ) : waiting ? (
          <div className={styles.toolbar} role="status">
            <span>Finish deleting in your browser…</span>
            <Button onClick={cancelWaiting}>Cancel</Button>
          </div>
        ) : (
          <Button
            variant="danger"
            disabled={action.busy || !action.enabled}
            onClick={() => {
              setNotice(null);
              action.setError(null);
              setConfirming(true);
            }}
          >
            Delete account…
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className={styles.hint}>
          {notice}
        </p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      )}
    </div>
  );
}
