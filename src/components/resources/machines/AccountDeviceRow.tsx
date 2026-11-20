/**
 * AccountDeviceRow — one device signed in to the AASC Cloud account (RESOURCES → Machines › Devices on your
 * account, plan 18): its name, its kind and system in words, when it last used the account, and Sign out….
 *
 * This computer's own row says "this computer" and has no action: it signs out from the cloud account dialog.
 *
 * Sign out… asks first, in the row, as the cloud account dialog does for Delete: the kind and the time give way
 * to the question with Cancel and Sign out. Cancel comes first and takes focus. The action column stays empty
 * while it asks, so neither answer can land under a pointer still resting where Sign out… was: a stray second
 * click presses nothing. The sign-out carries the connection it was reviewed under (`useCloudAction`), runs once
 * however often its button is pressed, and on success hands focus to the next row's action before the row goes.
 *
 * Two things hold whatever the cloud session does meanwhile (code review, Nov 20 2026). The double-press guard is
 * set only when a request really starts, and is freed when it ends or on Cancel: a press that `run` refuses
 * without sending anything can't lock the row. And when a request ends, however it ends, the section reads the
 * list again (`onSettled`): `run` drops its follow-up when the session moves on mid-request, and a device that
 * was in fact signed out would otherwise keep its row and say nothing.
 *
 * A refusal stays in the row, in the server's own words (`own_device`, `device_not_found`, `invalid_input`,
 * `cloud_unavailable`). `connection_changed` is read here, before the cloud views' shared wording of that code,
 * which speaks of a draft there is none of here: the row says to check again, and the section reads the connection
 * and the list again at once (`onStale`), so a retry carries the connection in force. A sign-out that got no
 * answer at all says so in the page's words.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import { useCloudAction } from '@/components/resources/cloud/cloudSession';
import { deviceWords } from '@/lib/accountDevices';
import { relativeTime } from '@/lib/chat/chatFormat';
import { CloudApiError, cloudApi, type AccountDevice } from '@/lib/cloudApi';
import { focusSiblingAfterRemoval } from '@/lib/focusAfterRemoval';
import styles from '@/styles/modules/AccountDevices.module.css';

/** What a row's removal hands focus to: another row's action. */
const ROW_ACTION = 'button:not([disabled])';
/** Said when the server finds the page's review of the connection stale (`connection_changed`). */
const CONNECTION_CHANGED = 'The cloud connection changed. Check again, then sign it out.';

interface Props {
  device: AccountDevice;
  /** Takes focus when the last row with an action goes: the section's heading. */
  fallbackFocus: RefObject<HTMLElement | null>;
  onSignedOut: (id: string) => void;
  /** The server said the page's review of the connection is stale: read the connection again. */
  onStale: () => void;
  /** A sign-out request ended, whatever came of it: read the list again. */
  onSettled: () => void;
}

export default function AccountDeviceRow({ device, fallbackFocus, onSignedOut, onStale, onSettled }: Props) {
  const action = useCloudAction();
  const [confirming, setConfirming] = useState(false);
  /** Why the last sign-out was refused, as the server said it. */
  const [refused, setRefused] = useState<string | null>(null);
  const rowRef = useRef<HTMLTableRowElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  /** Cancel was pressed: once the row is back, focus returns to its Sign out…. */
  const returnFocus = useRef(false);
  /** A sign-out request is out: a second press does nothing. Set only by a request that really started. */
  const out = useRef(false);

  useEffect(() => {
    if (confirming || !returnFocus.current) return;
    returnFocus.current = false;
    askRef.current?.focus();
  }, [confirming]);

  const cancel = () => {
    out.current = false;
    action.setError(null);
    setRefused(null);
    returnFocus.current = true;
    setConfirming(false);
  };

  const signOut = () => {
    if (out.current) return;
    setRefused(null);
    action.run(
      (binding, signal) => {
        out.current = true;
        // A refusal is an answer here, not a throw: `run` would word it with the cloud views' stock sentences.
        return cloudApi.signOutAccountDevice(device.id, binding, signal)
          .then((): unknown => null, (err: unknown): unknown => err ?? new Error('refused'))
          .finally(() => {
            out.current = false;
            onSettled();
          });
      },
      (failure) => {
        if (failure === null) {
          focusSiblingAfterRemoval(rowRef.current, ROW_ACTION, fallbackFocus.current);
          onSignedOut(device.id);
          return;
        }
        if (failure instanceof CloudApiError && failure.code === 'connection_changed') {
          setRefused(CONNECTION_CHANGED);
          onStale();
          return;
        }
        setRefused(failure instanceof CloudApiError ? failure.message : `Couldn’t sign out ${device.name}. Try again.`);
      },
    );
  };

  const error = refused ?? action.error;

  return (
    <tr ref={rowRef} role="row" className={styles.row}>
      <th scope="row" role="rowheader" className={styles.name}>
        <span className={styles.nameText} title={device.name}>{device.name}</span>
        {device.current && <Chip>this computer</Chip>}
      </th>
      {confirming ? (
        <>
          <td role="cell" colSpan={2} className={styles.confirmCell}>
            <span className={styles.confirm}>
              <span className={styles.question}>
                Sign out {device.name}? It has to sign in again to use your account. Computers signed in to your account
                disconnect it within 5 minutes.
              </span>
              {/* The destructive one is set apart by the fixed gap, never pushed to the far edge. */}
              <span className={styles.confirmActions}>
                <Button size="sm" autoFocus disabled={action.busy} onClick={cancel}>Cancel</Button>
                <Button size="sm" variant="danger" aria-busy={action.busy || undefined} onClick={signOut}>Sign out</Button>
              </span>
            </span>
            {error && <span className={styles.error} role="alert">{error}</span>}
          </td>
          <td role="cell" className={styles.action} />
        </>
      ) : (
        <>
          <td role="cell" className={styles.kind}>{deviceWords(device)}</td>
          <td role="cell" className={styles.used}>
            {device.lastUsedAt === null ? (
              <>Never<span className={styles.cardWords}> used</span></>
            ) : (
              <><span className={styles.cardWords}>Last used </span>{relativeTime(device.lastUsedAt)}</>
            )}
          </td>
          <td role="cell" className={styles.action}>
            {!device.current && (
              <Button
                ref={askRef}
                size="sm"
                variant="danger"
                aria-label={`Sign out ${device.name}…`}
                onClick={() => setConfirming(true)}
              >
                Sign out…
              </Button>
            )}
          </td>
        </>
      )}
    </tr>
  );
}
