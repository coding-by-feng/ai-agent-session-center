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
 *
 * The ⋯ menu is the shared `Menu`, portaled to <body>: its popover sits outside
 * the device panel, so DevicePresenceChip's outside-click test skips
 * `[data-menu-popover]`, and this module's CSS lifts it above the panel.
 */
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from 'react';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import Menu from '@/components/ui/Menu';
import TextArea from '@/components/ui/TextArea';
import TextInput from '@/components/ui/TextInput';
import { showToast } from '@/components/ui/ToastContainer';
import { focusSiblingAfterRemoval } from '@/lib/focusAfterRemoval';
import { formatConfirmCode } from '@/lib/mobilePairingApi';
import type { RemoteComputer, RemoteComputerCheck, RemoteComputersAPI } from '@/types/electron';
import styles from '@/styles/modules/RemoteComputers.module.css';

/** How often every row is re-checked while the panel is open. */
const CHECK_EVERY_MS = 30_000;
/** How often a computer waiting for Allow is asked again. */
const WAIT_POLL_MS = 3_000;
/** When to stop asking a computer whose owner never answered. */
const WAIT_GIVE_UP_MS = 10 * 60_000;
/** The same cap as a paired phone's name. */
const MAX_NAME = 80;
/** What a row's removal hands focus to: another row's controls. */
const ROW_CONTROL = 'button:not([disabled])';

type RowState = RemoteComputerCheck['state'] | 'checking';

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The live check wins; before the first one, the stored status says what it can. */
function rowState(c: RemoteComputer, check: RemoteComputerCheck | undefined): RowState {
  if (check) return check.state;
  if (c.status === 'revoked') return 'revoked';
  return c.status === 'pending' ? 'pending' : 'checking';
}

/** The row's second line. It always names the state, so the dot's colour is never the only sign. */
function rowDetail(c: RemoteComputer, check: RemoteComputerCheck | undefined): string {
  const state = rowState(c, check);
  if (state === 'online') {
    const via = check?.via === 'tailnet' ? 'Tailscale' : check?.via === 'lan' ? 'Home network' : null;
    const shared = check?.sharedSessions != null ? `${check.sharedSessions} shared` : null;
    return ['Online', via, shared].filter(Boolean).join(' · ');
  }
  if (state === 'pending') {
    return c.confirmCode ? `Waiting for Allow · code ${formatConfirmCode(c.confirmCode)}` : 'Waiting for Allow';
  }
  if (state === 'offline') return check?.message ? `Offline: ${check.message}` : 'Offline';
  if (state === 'revoked') return 'Removed on that computer';
  return 'Checking…';
}

export default function RemoteComputers() {
  const api = window.electronAPI?.remotes;
  if (!api) return null;
  return <RemoteComputersSection api={api} />;
}

interface Waiting {
  id: string;
  name: string;
  code: string | null;
  gaveUp: boolean;
}

function RemoteComputersSection({ api }: { api: RemoteComputersAPI }) {
  const [computers, setComputers] = useState<RemoteComputer[] | null>(null);
  const [checks, setChecks] = useState<Record<string, RemoteComputerCheck>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const inFlight = useRef(new Set<string>());
  const addButtonRef = useRef<HTMLButtonElement>(null);

  const reload = useCallback(async (): Promise<RemoteComputer[] | null> => {
    try {
      const list = await api.list();
      setComputers(list);
      setLoadError(null);
      return list;
    } catch (err) {
      setLoadError(errorText(err));
      return null;
    }
  }, [api]);

  /** One check of one row; null when that row is already being checked. */
  const checkOne = useCallback(async (id: string): Promise<RemoteComputerCheck | null> => {
    if (inFlight.current.has(id)) return null;
    inFlight.current.add(id);
    let next: RemoteComputerCheck;
    try {
      const res = await api.check(id);
      next = res.ok ? res.data : { state: 'offline', via: null, sharedSessions: null, message: res.error };
    } catch (err) {
      next = { state: 'offline', via: null, sharedSessions: null, message: errorText(err) };
    } finally {
      inFlight.current.delete(id);
    }
    setChecks((prev) => ({ ...prev, [id]: next }));
    return next;
  }, [api]);

  useEffect(() => {
    let alive = true;
    const round = async () => {
      const list = await reload();
      if (!alive || !list) return;
      await Promise.all(list.filter((c) => c.status !== 'revoked').map((c) => checkOne(c.id)));
      // A check updates status, tailnet and lastSeenAt on the stored row.
      if (alive) await reload();
    };
    void round();
    const timer = setInterval(() => void round(), CHECK_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reload, checkOne]);

  const waitingId = waiting && !waiting.gaveUp ? waiting.id : null;
  const waitingName = waiting?.name ?? '';
  useEffect(() => {
    if (!waitingId) return undefined;
    let alive = true;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started >= WAIT_GIVE_UP_MS) {
        clearInterval(timer);
        setWaiting((w) => (w?.id === waitingId ? { ...w, gaveUp: true } : w));
        return;
      }
      void checkOne(waitingId).then((res) => {
        // Offline is not an answer: the other computer may just be asleep for a moment.
        if (!alive || !res || res.state === 'pending' || res.state === 'offline') return;
        setWaiting((w) => (w?.id === waitingId ? null : w));
        void reload();
        showToast(res.state === 'online' ? `${waitingName} is paired` : `${waitingName} refused this computer`, 'info', 3000);
      });
    }, WAIT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [waitingId, waitingName, checkOne, reload]);

  const handleAdded = (c: RemoteComputer) => {
    if (c.status === 'pending') setWaiting({ id: c.id, name: c.name, code: c.confirmCode, gaveUp: false });
    else showToast(`${c.name} is paired`, 'info', 3000);
    void reload().then(() => checkOne(c.id));
  };

  const handleRemoved = (id: string) => {
    setComputers((list) => list?.filter((c) => c.id !== id) ?? list);
    setChecks((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
    setWaiting((w) => (w?.id === id ? null : w));
  };

  const list = computers ?? [];
  const waitingCheck = waiting ? checks[waiting.id] : undefined;

  return (
    <section className={styles.section} aria-label="Remote computers">
      <AddComputer api={api} buttonRef={addButtonRef} onAdded={handleAdded} />

      {waiting && (
        <div className={styles.waiting} role="status">
          <span className={styles.waitingText}>
            On <strong>{waiting.name}</strong>, press Allow for this computer.
            {waiting.code && <> Check it shows <code className={styles.code}>{formatConfirmCode(waiting.code)}</code>.</>}
          </span>
          {waiting.gaveUp ? (
            <span className={styles.note}>
              Stopped waiting after 10 minutes. It stays in the list and is checked every 30 seconds.
            </span>
          ) : waitingCheck?.state === 'offline' ? (
            <span className={styles.note}>Can’t reach {waiting.name} right now. Still trying.</span>
          ) : null}
          <span>
            <Button size="sm" variant="quiet" onClick={() => setWaiting(null)}>Dismiss</Button>
          </span>
        </div>
      )}

      {list.length > 0 && (
        <ul className={styles.list}>
          {list.map((c) => (
            <RemoteRow
              key={c.id}
              api={api}
              computer={c}
              check={checks[c.id]}
              fallbackFocus={addButtonRef}
              onChanged={() => void reload()}
              onRecheck={() => void checkOne(c.id).then(() => reload())}
              onRemoved={handleRemoved}
            />
          ))}
        </ul>
      )}

      {computers !== null && list.length === 0 && !waiting && (
        <p className={styles.note}>No remote computers yet.</p>
      )}

      {loadError && <p className={styles.error} role="alert">{loadError}</p>}
    </section>
  );
}

interface AddComputerProps {
  api: RemoteComputersAPI;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onAdded: (c: RemoteComputer) => void;
}

/** The section's head: its title, "Add a computer", and the pairing-link form it opens. */
function AddComputer({ api, buttonRef, onAdded }: AddComputerProps) {
  const [open, setOpen] = useState(false);
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
      <div className={styles.head}>
        <span className={styles.title}>Remote computers</span>
        {!open && (
          <Button ref={buttonRef} size="sm" onClick={() => setOpen(true)}>+ Add a computer</Button>
        )}
      </div>

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
              {busy ? 'Pairing…' : 'Pair'}
            </Button>
            <Button size="sm" variant="quiet" onClick={close}>Cancel</Button>
          </span>
        </form>
      )}
    </>
  );
}

interface RemoteRowProps {
  api: RemoteComputersAPI;
  computer: RemoteComputer;
  check: RemoteComputerCheck | undefined;
  fallbackFocus: RefObject<HTMLButtonElement | null>;
  onChanged: () => void;
  /** Check this row again now (a failed Open usually means its state changed). */
  onRecheck: () => void;
  onRemoved: (id: string) => void;
}

function RemoteRow({ api, computer: c, check, fallbackFocus, onChanged, onRecheck, onRemoved }: RemoteRowProps) {
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const rowRef = useRef<HTMLLIElement>(null);

  const state = rowState(c, check);
  const canOpen = c.status === 'active' && state !== 'revoked' && state !== 'pending';

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

  const remove = async () => {
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
      showToast(
        res.data.unpairedRemotely
          ? `Removed ${c.name} and unpaired it there`
          : `Removed ${c.name}. It didn’t answer, so it may still list this computer.`,
        'info',
        4000,
      );
      focusSiblingAfterRemoval(rowRef.current, ROW_CONTROL, fallbackFocus.current);
      onRemoved(c.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const editing = draft !== null;
  const draftName = draft?.trim() ?? '';

  return (
    <li ref={rowRef} className={styles.row}>
      <span className={editing ? `${styles.top} ${styles.topEditing}` : styles.top}>
        <span className={`${styles.dot} ${styles[state]}`} aria-hidden="true" />
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
              <Button
                size="sm"
                variant="primary"
                disabled={!canOpen}
                aria-busy={opening || undefined}
                aria-label={`Open ${c.name}`}
                onClick={() => void open()}
              >
                {opening ? 'Opening…' : 'Open'}
              </Button>
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
            </span>
          </>
        )}
      </span>

      <span className={styles.meta}>{rowDetail(c, check)}</span>

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

      {error && <span className={styles.error} role="alert">{error}</span>}
    </li>
  );
}
