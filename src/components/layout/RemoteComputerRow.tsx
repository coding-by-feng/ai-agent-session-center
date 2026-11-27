/**
 * RemoteComputerRow — one other AASC computer this app holds a record for: a status dot and its words, **Open**,
 * and the ⋯ menu (Rename, Remove…). It was `RemoteRow` inside RemoteComputers.tsx until Nov 20 2026; a computer
 * paired by link draws exactly what it drew there.
 *
 * The devices switcher (plan 18) draws the same row for a computer connected through the AASC Cloud account and
 * passes `account`, which changes only this:
 *   · the second line is the switcher's own words (`detail`);
 *   · while it waits for Allow the one action is **Dismiss**, which forgets the record at once, with no ⋯ menu;
 *   · Open is off until the first check answers;
 *   · `connect` puts **Connect** in Open's place (the machine no longer takes this record), and the dot is grey,
 *     never the red of a link row's "Removed": this row can be connected again from here;
 *   · `alert` shows under the row when the row has no newer error of its own. The row's own error (a failed Open,
 *     Rename or Remove) is dropped when Connect runs and when the record's status changes, so it cannot outlive
 *     what it was about and hide what Connect answers.
 * A row with no ⋯ menu keeps the menu's place (`MenuSlot`), so its action ends where every other row's does and
 * does not jump when the row goes from Dismiss to Open.
 *
 * In the switcher every row's one action (Open, Connect, Dismiss) is marked `PRIMARY_ACTION`, which its ↑ ↓ Home End
 * move between (`useSwitcherKeys`). Dismiss and Connect exist only there; Open is marked when the switcher asks
 * (`arrowKeys`), so the row "Remote computers" draws is the markup it always was.
 *
 * The ⋯ menu is the shared `Menu`, portaled to <body>: see RemoteComputers.tsx for what that needs from the panel.
 */
import { useRef, useState, type RefObject } from 'react';
import Button from '@/components/ui/Button';
import Menu from '@/components/ui/Menu';
import TextInput from '@/components/ui/TextInput';
import { showToast } from '@/components/ui/ToastContainer';
import { errorText } from '@/hooks/useRemoteComputers';
import { PRIMARY_ACTION } from '@/hooks/useSwitcherKeys';
import { focusSiblingAfterRemoval } from '@/lib/focusAfterRemoval';
import type { RowBadges as RowBadgeSet } from '@/lib/remoteComputerBadges';
import { rowDetail, rowState } from '@/lib/remoteComputerRows';
import type { RemoteComputer, RemoteComputerCheck, RemoteComputersAPI } from '@/types/electron';
import kit from '@/styles/modules/Button.module.css';
import styles from '@/styles/modules/RemoteComputers.module.css';
import RowBadges from './RowBadges';

/** The same cap as a paired phone's name. */
const MAX_NAME = 80;
/** What a row's removal hands focus to: another row's controls. */
const ROW_CONTROL = 'button:not([disabled])';
/** On a row's primary action in the switcher. */
const PRIMARY = { [PRIMARY_ACTION]: '' };

/** What an account computer's row says and does differently from one paired by link. */
export interface AccountRowWords {
  /** Names the row for the switcher, which hands focus back to it when Connect or Dismiss redraws it. */
  rowKey: string;
  /** The second line. */
  detail: string;
  /** Connect in place of Open; null while Open is the action. */
  connect: { running: boolean; run: () => void } | null;
  /** The last Connect or check that was refused, as given. */
  alert: string | null;
}

export interface RemoteComputerRowProps {
  api: RemoteComputersAPI;
  computer: RemoteComputer;
  check: RemoteComputerCheck | undefined;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  onChanged: () => void;
  /** Check this row again now (a failed Open usually means its state changed). */
  onRecheck: () => void;
  onRemoved: (id: string) => void;
  onOpened?: (id: string) => void;
  account?: AccountRowWords;
  /** The switcher's rows: Open takes part in its ↑ ↓ Home End. */
  arrowKeys?: boolean;
  /** The switcher's rows (Nov 27 2026): the second line as pills, its sentence kept for screen readers. */
  badges?: RowBadgeSet;
}

export default function RemoteComputerRow({
  api, computer: c, check, fallbackFocus, onChanged, onRecheck, onRemoved, onOpened, account, arrowKeys = false, badges,
}: RemoteComputerRowProps) {
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);
  // An account row's error is about the record as it was: once its status moves on (allowed, removed, enrolled
  // again) the error goes. Adopted during render, not in an effect. A link row keeps its error: there it is the
  // sentence that says what to do next ("Remove it here and pair again").
  const [statusSeen, setStatusSeen] = useState(c.status);
  if (c.status !== statusSeen) {
    setStatusSeen(c.status);
    if (account !== undefined) setError(null);
  }

  const state = rowState(c, check);
  const waitsForAllow = account !== undefined && state === 'pending';
  const canOpen = c.status === 'active' && state !== 'revoked' && state !== 'pending'
    && !(account !== undefined && state === 'checking');

  const open = async () => {
    if (opening) return;
    setOpening(true);
    setError(null);
    try {
      const res = await api.open(c.id);
      if (!res.ok) {
        setError(res.error);
        // Revoked, back to pending or gone offline: without this the row reads "Online" until the 30 s check.
        onRecheck();
      } else {
        onOpened?.(c.id);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setOpening(false);
    }
  };

  const saveName = async () => {
    const name = draft?.trim() ?? '';
    if (!name || name === c.name || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.rename(c.id, name);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDraft(null);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /** `quiet`: Dismiss, whose row says what happened by going back to "Not connected yet". */
  const remove = async (quiet = false) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.remove(c.id);
      if (!res.ok) {
        setError(res.error);
        setBusy(false);
        return;
      }
      if (!quiet) {
        showToast(
          res.data.unpairedRemotely
            ? `Removed ${c.name} and unpaired it there`
            : `Removed ${c.name}. It didn’t answer, so it may still list this computer.`,
          'info',
          4000,
        );
      }
      focusSiblingAfterRemoval(rowRef.current, ROW_CONTROL, fallbackFocus.current);
      onRemoved(c.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const editing = draft !== null;
  const draftName = draft?.trim() ?? '';
  const connect = account?.connect ?? null;
  const shownError = error ?? account?.alert ?? null;
  // An account row removed on that computer offers Connect: a grey dot, not the red of a link row's "Removed".
  const dot = account !== undefined && state === 'revoked' ? styles.dot : `${styles.dot} ${styles[state]}`;

  return (
    <li ref={rowRef} className={styles.row} data-account-row={account?.rowKey}>
      <span className={editing ? `${styles.top} ${styles.topEditing}` : styles.top}>
        <span className={dot} aria-hidden="true" />
        {editing ? (
          <span className={styles.rename}>
            <TextInput
              className={styles.renameInput}
              aria-label="Computer name"
              value={draft}
              maxLength={MAX_NAME}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void saveName(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setDraft(null); setError(null); }
              }}
            />
            <span className={styles.actions}>
              <Button
                size="sm"
                variant="primary"
                disabled={!draftName || draftName === c.name}
                aria-busy={busy || undefined}
                onClick={() => void saveName()}
              >
                Save
              </Button>
              <Button size="sm" variant="quiet" onClick={() => { setDraft(null); setError(null); }}>Cancel</Button>
            </span>
          </span>
        ) : (
          <>
            <span className={styles.name} title={c.name}>{c.name}</span>
            <span className={styles.rowActions}>
              {waitsForAllow ? (
                <Button {...PRIMARY} size="sm" aria-busy={busy || undefined} aria-label={`Dismiss ${c.name}`} onClick={() => void remove(true)}>
                  Dismiss
                </Button>
              ) : connect ? (
                <ConnectButton
                  name={c.name}
                  running={connect.running}
                  onConnect={() => {
                    setError(null);
                    connect.run();
                  }}
                />
              ) : (
                <Button
                  {...(arrowKeys ? PRIMARY : undefined)}
                  size="sm"
                  variant="primary"
                  disabled={!canOpen}
                  aria-busy={opening || undefined}
                  aria-label={`Open ${c.name}`}
                  onClick={() => void open()}
                >
                  {opening ? 'Opening…' : 'Open'}
                </Button>
              )}
              {waitsForAllow ? <MenuSlot /> : (
                <Menu
                  label={`${c.name} actions`}
                  triggerLabel={`More for ${c.name}`}
                  triggerIcon={<span aria-hidden="true">⋯</span>}
                  align="end"
                  sections={[{
                    id: 'row',
                    items: [
                      { kind: 'action', id: 'rename', label: 'Rename', onSelect: () => { setConfirmRemove(false); setDraft(c.name); } },
                      { kind: 'action', id: 'remove', label: 'Remove…', onSelect: () => setConfirmRemove(true) },
                    ],
                  }]}
                />
              )}
            </span>
          </>
        )}
      </span>

      {badges
        ? <RowBadges badges={badges.badges} reason={badges.reason} sentence={account ? account.detail : rowDetail(c, check)} />
        : <span className={styles.meta}>{account ? account.detail : rowDetail(c, check)}</span>}

      {confirmRemove && (
        <span className={styles.confirm} role="alert">
          <span>Remove {c.name}? It is unpaired there too when it answers.</span>
          <span className={styles.actions}>
            <Button size="sm" variant="danger" aria-busy={busy || undefined} onClick={() => void remove()}>
              {busy ? 'Removing…' : 'Remove'}
            </Button>
            <Button size="sm" variant="quiet" onClick={() => setConfirmRemove(false)}>Keep</Button>
          </span>
        </span>
      )}

      {shownError && <span className={styles.error} role="alert">{shownError}</span>}
    </li>
  );
}

/**
 * Connect, for an account computer. While it runs it is `aria-disabled`, never `disabled`: a button that disables
 * itself under the pointer or the keyboard drops focus to <body>. A press while it runs does nothing. The row's
 * second line says "Connecting…", so the label stays put.
 */
export function ConnectButton({ name, running, onConnect }: { name: string; running: boolean; onConnect: () => void }) {
  return (
    <Button
      {...PRIMARY}
      size="sm"
      variant="primary"
      className={running ? styles.held : undefined}
      aria-disabled={running || undefined}
      aria-busy={running || undefined}
      aria-label={`Connect ${name}`}
      onClick={running ? undefined : onConnect}
    >
      Connect
    </Button>
  );
}

/**
 * The ⋯ menu's place in a row that has no menu. It takes the kit's own icon-button box (24px, 44px under a finger),
 * so it can't drift from the real trigger; hidden, it is out of the tab order and the accessibility tree.
 */
export function MenuSlot() {
  return <span className={`${kit.iconButton} ${kit.iconSm} ${styles.menuSlot}`} aria-hidden="true" />;
}
