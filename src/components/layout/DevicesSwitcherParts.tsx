/**
 * DevicesSwitcherParts — the pieces of the Switch part that are not a computer this app holds a record for
 * (`RemoteComputerRow` draws those): this computer's own row, an account computer never connected to, and the line
 * said when the account's computers could not be listed. They were inside DevicesSwitcher.tsx until its search and
 * keyboard handling arrived.
 */
import { useNavigate } from 'react-router';
import Button from '@/components/ui/Button';
import type { DirectoryView } from '@/hooks/useAccountDirectory';
import { IS_LITE } from '@/lib/edition';
import { sessionsLine, type AccountRow } from '@/lib/remoteComputerRows';
import { countListedSessions, countSessionsNeedingYou } from '@/lib/sessionNeeds';
import { useSessionStore } from '@/stores/sessionStore';
import rows from '@/styles/modules/RemoteComputers.module.css';
import styles from '@/styles/modules/DevicesSwitcher.module.css';
import { ConnectButton, MenuSlot } from './RemoteComputerRow';

// Lite has no RESOURCES tab, where the ☁ account lives: its two lines say where to sign in, and carry no action.
const SIGNED_OUT = IS_LITE
  ? 'Sign in to AASC Cloud in the full AASC app to list your computers.'
  : 'Sign in to AASC Cloud to list your computers.';
const NEEDS_SIGN_IN = IS_LITE
  ? 'This computer signed in before its computers could be listed. Sign out of AASC Cloud and sign in again in the full AASC app.'
  : 'This computer signed in before its computers could be listed. Sign out of AASC Cloud and sign in again.';
const UNREACHABLE = 'Can’t reach AASC Cloud. Computers you already connected still work.';
/** RESOURCES with its ☁ account dialog open (`account=1`, ResourcesView). */
const CLOUD_ACCOUNT_PATH = '/resources?account=1';

/**
 * This computer: its name and "here", and under them its sessions and how many of them need the person, when it has
 * any. The two counts are two store selectors that each return a number, so the row is redrawn when a count changes
 * and not on every session update; the rest of the part reads nothing from the session store.
 */
export function ThisComputerRow({ name }: { name: string }) {
  const sessions = useSessionStore((s) => countListedSessions(s.sessions));
  const needsYou = useSessionStore((s) => countSessionsNeedingYou(s.sessions));
  const line = sessionsLine(sessions, needsYou);
  return (
    <li className={rows.row}>
      <span className={rows.top}>
        <span className={`${rows.dot} ${rows.online}`} aria-hidden="true" />
        <span className={rows.name} title={name}>{name}</span>
        <span className={styles.aside}>here</span>
      </span>
      {line && <span className={rows.meta}>{line}</span>}
    </li>
  );
}

interface UnconnectedRowProps {
  row: AccountRow;
  running: boolean;
  error: string | null;
  onConnect: () => void;
}

/**
 * An account computer this one has never connected to: its name, and Connect. One that signed in before it could
 * take a connection (`connectable: false`) says what to do there and offers nothing here; the action's place is
 * kept, so the row is as tall as its neighbours.
 */
export function UnconnectedRow({ row, running, error, onConnect }: UnconnectedRowProps) {
  const words = !row.connectable
    ? `Sign in to AASC Cloud again on ${row.name} to connect it.`
    : running ? 'Connecting…' : 'Not connected yet';
  return (
    <li className={rows.row} data-account-row={row.key}>
      <span className={rows.top}>
        <span className={`${rows.dot} ${rows.checking}`} aria-hidden="true" />
        <span className={rows.name} title={row.name}>{row.name}</span>
        <span className={rows.rowActions}>
          {row.connectable && <ConnectButton name={row.name} running={running} onConnect={onConnect} />}
          <MenuSlot />
        </span>
      </span>
      <span className={rows.meta}>{words}</span>
      {error && <span className={rows.error} role="alert">{error}</span>}
    </li>
  );
}

interface DirectoryNoticeProps {
  view: DirectoryView;
  retrying: boolean;
  onRetry: () => void;
  onLeave?: () => void;
}

/**
 * One line for a directory that could not be listed, with at most one action. Nothing while it is listed. While a
 * Retry's read is out the line says so; the button stays (and stays focused), busy.
 */
export function DirectoryNotice({ view, retrying, onRetry, onLeave }: DirectoryNoticeProps) {
  if (view.state === 'ok') return null;
  if (view.state === 'loading') return <p className={rows.note} role="status">Checking…</p>;
  if (view.state === 'signed-out' || view.state === 'needs-sign-in') {
    return (
      <div className={styles.notice}>
        <span className={styles.noticeText}>{view.state === 'signed-out' ? SIGNED_OUT : NEEDS_SIGN_IN}</span>
        {!IS_LITE && <OpenCloudButton onLeave={onLeave} />}
      </div>
    );
  }
  return (
    <div className={styles.notice}>
      {retrying
        ? <span className={styles.noticeText} role="status">Checking…</span>
        : view.state === 'failed'
          ? <span className={`${styles.noticeText} ${styles.noticeError}`} role="alert">{view.error}</span>
          : <span className={styles.noticeText}>{UNREACHABLE}</span>}
      <Button size="sm" aria-busy={retrying || undefined} onClick={onRetry}>Retry</Button>
    </div>
  );
}

/** Its own component so the router is asked only where the button shows. */
function OpenCloudButton({ onLeave }: { onLeave?: () => void }) {
  const navigate = useNavigate();
  return (
    <Button
      size="sm"
      onClick={() => {
        void navigate(CLOUD_ACCOUNT_PATH);
        onLeave?.();
      }}
    >
      Open AASC Cloud
    </Button>
  );
}
