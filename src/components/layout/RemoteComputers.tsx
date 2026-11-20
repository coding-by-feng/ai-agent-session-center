/**
 * RemoteComputers — "Remote computers" inside the device panel (Oct 28 2026).
 *
 * This desktop app pairs with another computer's AASC the way the phone app
 * does: paste the pairing link that computer's devices panel shows, its owner
 * presses Allow after comparing a 6-digit code, and from then on **Open** signs
 * in and shows that computer's own UI in a separate window.
 *
 * All the work happens in Electron's main process (`window.electronAPI.remotes`,
 * contract in src/types/electron.d.ts); this component only lists, checks and
 * asks. Without that API (a browser, an older app) it renders nothing.
 *
 * Every row is checked when the panel opens and every 30 s while it stays open,
 * never two checks of the same row at once (`inFlight`). A computer just added
 * is checked every 3 s until its owner answers, for at most 10 minutes.
 * (That state is `useRemoteComputers`, and a row is `RemoteComputerRow`, since
 * Nov 20 2026: the devices switcher shares both, with `AddComputer` and
 * `WaitingCard` from here.)
 *
 * The ⋯ menu is the shared `Menu`, portaled to <body>: its popover sits outside
 * the device panel, so DevicePresenceChip's outside-click test skips
 * `[data-menu-popover]`, and this module's CSS lifts it above the panel.
 */
import { useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import TextArea from '@/components/ui/TextArea';
import { errorText, useRemoteComputers, type Waiting } from '@/hooks/useRemoteComputers';
import { formatConfirmCode } from '@/lib/mobilePairingApi';
import type { RemoteComputer, RemoteComputerCheck, RemoteComputersAPI } from '@/types/electron';
import styles from '@/styles/modules/RemoteComputers.module.css';
import RemoteComputerRow from './RemoteComputerRow';

/** A Client edition's home page (src/client-home), where this list is the whole app. Keep these callbacks stable. */
export interface RemoteComputersClient {
  /** Open with the link box showing: nothing is paired yet. */
  startAdding: boolean;
  /** A computer just answered Allow, or needed none. */
  onAllowed: (id: string) => void;
  /** A row's Open worked. */
  onOpened: (id: string) => void;
  /**
   * The app brought this list back on screen; returns how to stop listening. It waits hidden behind a dashboard, so it
   * could otherwise say Offline for a computer that has long returned. Chromium doesn't say: on macOS a hidden window
   * stays "visible" and fires no visibilitychange. A Full or Lite panel needs none of this: it is only mounted while open.
   */
  onShown?: (listener: () => void) => () => void;
}

export default function RemoteComputers({ client }: { client?: RemoteComputersClient } = {}) {
  const api = window.electronAPI?.remotes;
  if (!api) return null;
  return <RemoteComputersSection api={api} client={client} />;
}

function RemoteComputersSection({ api, client }: { api: RemoteComputersAPI; client?: RemoteComputersClient }) {
  const { computers, checks, loadError, waiting, reload, checkOne, added, removed, dismissWaiting } = useRemoteComputers(api, {
    onAllowed: client?.onAllowed,
    onShown: client?.onShown,
  });
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const list = computers ?? [];

  return (
    <section className={client ? `${styles.section} ${styles.clientSection}` : styles.section} aria-label="Remote computers">
      <AddComputer api={api} buttonRef={addButtonRef} onAdded={added} client={client} />

      {waiting.map((w) => (
        <WaitingCard key={w.id} waiting={w} check={checks[w.id]} onDismiss={() => dismissWaiting(w.id)} />
      ))}

      {list.length > 0 && (
        <ul className={styles.list}>
          {list.map((c) => (
            <RemoteComputerRow
              key={c.id}
              api={api}
              computer={c}
              check={checks[c.id]}
              fallbackFocus={addButtonRef}
              onChanged={() => void reload()}
              onRecheck={() => void checkOne(c.id).then(() => reload())}
              onRemoved={removed}
              onOpened={client?.onOpened}
            />
          ))}
        </ul>
      )}

      {computers !== null && list.length === 0 && waiting.length === 0 && !client && (
        <p className={styles.note}>No remote computers yet.</p>
      )}

      {loadError && <p className={styles.error} role="alert">{loadError}</p>}
    </section>
  );
}

/** The amber card for a computer paired by link whose owner has not pressed Allow yet. */
export function WaitingCard({ waiting, check, onDismiss }: { waiting: Waiting; check: RemoteComputerCheck | undefined; onDismiss: () => void }) {
  return (
    <div className={styles.waiting} role="status">
      <span className={styles.waitingText}>
        On <strong>{waiting.name}</strong>, press Allow for this computer.
        {waiting.code && <> Check it shows <code className={styles.code}>{formatConfirmCode(waiting.code)}</code>.</>}
      </span>
      {waiting.gaveUp ? (
        <span className={styles.note}>
          Stopped waiting after 10 minutes. It stays in the list and is checked every 30 seconds.
        </span>
      ) : check?.state === 'offline' ? (
        <span className={styles.note}>Can’t reach {waiting.name} right now. Still trying.</span>
      ) : null}
      <span>
        <Button size="sm" variant="quiet" onClick={onDismiss}>Dismiss</Button>
      </span>
    </div>
  );
}

interface AddComputerProps {
  api: RemoteComputersAPI;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onAdded: (c: RemoteComputer) => void;
  client?: RemoteComputersClient;
  /** The devices switcher: no title of its own, and the button says what kind of adding this is. */
  bare?: boolean;
  /** With `bare`: something to draw beside the button, in the same row (the switcher's "Manage devices…"). */
  aside?: ReactNode;
}

/** The section's head: its title, "Add a computer", and the pairing-link form it opens. */
export function AddComputer({ api, buttonRef, onAdded, client, bare = false, aside }: AddComputerProps) {
  const [open, setOpen] = useState(client?.startAdding ?? false);
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const helpId = useId();

  const close = () => {
    setOpen(false);
    setLink('');
    setError(null);
  };

  const pair = async () => {
    const trimmed = link.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.add(trimmed);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      close();
      onAdded(res.data);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {bare ? !open && (
        <div className={`${styles.head} ${styles.footer}`}>
          <Button ref={buttonRef} size="sm" onClick={() => setOpen(true)}>+ Add a computer by link</Button>
          {aside}
        </div>
      ) : (
        <div className={styles.head}>
          <span className={styles.title}>{client ? 'Computers' : 'Remote computers'}</span>
          {!open && (
            <Button ref={buttonRef} size="sm" onClick={() => setOpen(true)}>+ Add a computer</Button>
          )}
        </div>
      )}

      {open && (
        <form
          className={styles.addForm}
          onSubmit={(e) => {
            e.preventDefault();
            void pair();
          }}
        >
          <Field label="Pairing link" className={styles.linkField}>
            <TextArea
              className={styles.linkInput}
              value={link}
              rows={3}
              placeholder="https://aasc.work/pair#…"
              autoFocus
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={helpId}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void pair(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
              }}
            />
          </Field>
          <span id={helpId} className={styles.note}>
            On the other computer, open AASC, click the devices chip, press “Pair a phone or computer” and copy its link.
          </span>
          {error && <p className={styles.error} role="alert">{error}</p>}
          <span className={styles.actions}>
            <Button type="submit" size="sm" variant="primary" disabled={!link.trim()} aria-busy={busy || undefined}>
              {client ? (busy ? 'Connecting…' : 'Connect') : (busy ? 'Pairing…' : 'Pair')}
            </Button>
            <Button size="sm" variant="quiet" onClick={close}>Cancel</Button>
          </span>
        </form>
      )}
    </>
  );
}
