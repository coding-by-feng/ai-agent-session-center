/**
 * DevicesSwitcher — the Switch part of the devices panel (plan 18 stage 2, Nov 20 2026): every other AASC computer
 * this one can open, in up to three sections, a section with no rows not drawn.
 *
 *   Search computers the field, over seven computer rows: it filters the rows below by the name shown
 *   THIS COMPUTER    the account's entry for this computer: its name and "here", then its sessions and how many need you
 *   MY COMPUTERS     the other computers on this computer's AASC Cloud account      N of M online
 *   PAIRED BY LINK   computers paired with a pairing link (what "Remote computers" lists)
 *   + Add a computer by link     Manage devices… (Full, with the directory listed: RESOURCES → Machines)
 *
 * An account computer needs no link: **Connect** asks Electron's main process (`remotes.accountConnect`), and the
 * record it answers is then a row like any other: checked every 30 s, Open, and Rename / Remove in the ⋯ menu.
 * Connect comes back in Open's place when the machine removed this computer (`needsConnect`): it enrolls again
 * into the same row.
 * A record made through the account never shows under "Paired by link" (`remoteComputerRows.ts`).
 *
 * Only where the account channels exist: the desktop app on this computer, Full and Lite. Without them (a browser,
 * an older app, a Client edition, whose list is `RemoteComputers`) it renders nothing.
 *
 * The row ⋯ menu is portaled to <body>, so the panel's outside-click test skips `[data-menu-popover]` and this
 * module's CSS lifts it over the panel, as RemoteComputers does.
 *
 * Search (plan 18 §5.4): with more than seven computer rows (account and link; this computer is not one) a field
 * filters them by name. A section with no row left is not drawn, this computer's row stays, and with no match one
 * line says so. The field's text counts only while the field is shown. From the keyboard: `useSwitcherKeys`.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { buttonClass } from '@/components/ui/buttonClass';
import SearchInput from '@/components/ui/SearchInput';
import { APP_UNREACHABLE, useAccountDirectory } from '@/hooks/useAccountDirectory';
import { useRemoteComputers } from '@/hooks/useRemoteComputers';
import { useSwitcherKeys } from '@/hooks/useSwitcherKeys';
import { DEVICES_SWITCH_EVENT } from '@/lib/devicesSwitcher';
import { IS_LITE } from '@/lib/edition';
import {
  accountRowDetail, accountRows, countOnline, linkRecords, matchesName, needsConnect, searchShown, type AccountRow,
} from '@/lib/remoteComputerRows';
import { useShortcutStore } from '@/stores/shortcutStore';
import type { RemoteComputer, RemoteComputersAPI, RemoteResult } from '@/types/electron';
import rows from '@/styles/modules/RemoteComputers.module.css';
import styles from '@/styles/modules/DevicesSwitcher.module.css';
import { DirectoryNotice, ThisComputerRow, UnconnectedRow } from './DevicesSwitcherParts';
import RemoteComputerRow from './RemoteComputerRow';
import { AddComputer, WaitingCard } from './RemoteComputers';

const ONLY_THIS_ONE = 'Sign in on another computer with the same Google account and it shows up here.';
/** RESOURCES → Machines, where "Devices on your account" lists every device and signs one out. */
const MACHINES_PATH = '/resources?section=machines';

function without(map: Record<string, string>, key: string): Record<string, string> {
  if (!(key in map)) return map;
  return Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
}

export interface DevicesSwitcherProps {
  /** A link in the part was followed: the panel closes. */
  onLeave?: () => void;
  /** The panel has just opened on this part: focus goes into it (`useSwitcherKeys`). */
  focusOnOpen?: boolean;
}

export default function DevicesSwitcher({ onLeave, focusOnOpen = false }: DevicesSwitcherProps) {
  const api = window.electronAPI?.remotes;
  if (!api?.accountMachines || !api.accountConnect) return null;
  return <Switcher api={api} onLeave={onLeave} focusOnOpen={focusOnOpen} />;
}

function Switcher({ api, onLeave, focusOnOpen }: { api: RemoteComputersAPI; onLeave?: () => void; focusOnOpen: boolean }) {
  const remotes = useRemoteComputers(api);
  const directory = useAccountDirectory(api);
  const [text, setText] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  /** By row key: a Connect that is running, and why the last one failed. */
  const [connecting, setConnecting] = useState<ReadonlySet<string>>(() => new Set());
  const [connectErrors, setConnectErrors] = useState<Record<string, string>>({});
  const running = useRef(new Set<string>());
  const rootRef = useRef<HTMLDivElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  /** A row that Connect, Dismiss or Remove is about to redraw: focus goes to the action it has next. */
  const refocus = useRef<string | null>(null);
  /** False once the panel has closed: a Connect that answers after that starts no check and no read. */
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  const { view } = directory;
  const machines = view.state === 'ok' ? view.machines : null;
  const here = machines?.find((m) => m.current) ?? null;
  const mine = accountRows(machines, remotes.computers);
  const byLink = linkRecords(remotes.computers);
  /** Link pairings waiting for Allow: each has its card. An account computer's own row says it waits. */
  const linkWaiting = remotes.waiting.filter((w) => !w.quiet);

  const searching = searchShown(mine.length + byLink.length);
  // The rows dropped to seven with a text typed: the field is gone, and so is what it filtered by.
  if (!searching && text !== '') setText('');
  const query = searching ? text.trim() : '';
  const named = <T extends { name: string }>(list: T[]): T[] => (query ? list.filter((item) => matchesName(item.name, query)) : list);
  const shownMine = named(mine);
  const shownLinks = named(byLink);
  const shownWaiting = named(linkWaiting);
  const noMatch = query !== '' && shownMine.length + shownLinks.length + shownWaiting.length === 0;

  const onKeyDown = useSwitcherKeys({
    rootRef,
    searchRef,
    focusOnOpen,
    drawn: remotes.computers !== null,
    settled: view.state !== 'loading',
  });

  /**
   * The app's shortcuts leave a text field its keys, and this field is where `switchDevice` puts focus: pressed
   * again here, the key asks the panel to close, as it does everywhere else. Never for a key that types: rebound
   * to a plain letter, the letter goes into the field.
   */
  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const types = e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (types || useShortcutStore.getState().findActionForEvent(e.nativeEvent) !== 'switchDevice') return;
    e.preventDefault();
    document.dispatchEvent(new CustomEvent(DEVICES_SWITCH_EVENT));
  };

  const rowElement = (key: string): HTMLElement | null => {
    const all = rootRef.current?.querySelectorAll<HTMLElement>('[data-account-row]') ?? [];
    return [...all].find((el) => el.dataset.accountRow === key) ?? null;
  };

  useEffect(() => {
    const key = refocus.current;
    if (key === null) return;
    refocus.current = null;
    rowElement(key)?.querySelector<HTMLElement>('button:not([disabled])')?.focus();
  });

  const connect = async (row: AccountRow) => {
    const { key, machineId } = row;
    if (machineId === null || running.current.has(key)) return;
    running.current.add(key);
    setConnecting(new Set(running.current));
    setConnectErrors((prev) => without(prev, key));
    let res: RemoteResult<RemoteComputer>;
    try {
      res = await api.accountConnect?.(machineId) ?? { ok: false, error: 'Connecting through an AASC Cloud account isn’t available here.' };
    } catch {
      res = { ok: false, error: APP_UNREACHABLE };
    }
    running.current.delete(key);
    if (!open.current) return;
    setConnecting(new Set(running.current));
    if (res.ok) {
      if (rowElement(key)?.contains(document.activeElement)) refocus.current = key;
      remotes.follow(res.data);
    } else {
      const { error } = res;
      setConnectErrors((prev) => ({ ...prev, [key]: error }));
    }
    directory.refresh();
  };

  /** Dismiss or Remove: the record is gone. A machine the account still lists keeps its row, back at Connect. */
  const forget = (row: AccountRow, id: string) => {
    remotes.removed(id);
    setConnectErrors((prev) => without(prev, row.key));
    if (machines?.some((m) => m.deviceId === row.machineId)) refocus.current = row.key;
    directory.refresh();
  };

  return (
    // The box takes no key itself: ↑ ↓ Home End bubble here from the search field and the rows' actions.
    <div ref={rootRef} className={styles.switcher} onKeyDown={onKeyDown}>
      {searching && (
        <SearchInput
          variant="field"
          value={text}
          onChange={setText}
          debounceMs={0}
          placeholder="Search computers"
          ariaLabel="Search computers"
          inputRef={searchRef}
          onKeyDown={onSearchKey}
        />
      )}

      <DirectoryNotice view={view} retrying={directory.retrying} onRetry={directory.retry} onLeave={onLeave} />

      {here && (
        <section className={styles.group} aria-label="This computer">
          <span className={rows.title}>This computer</span>
          <ul className={rows.list}>
            <ThisComputerRow name={here.name} />
          </ul>
        </section>
      )}

      {noMatch && <p className={`${rows.note} ${styles.noMatch}`} role="status">No computer matches “{query}”.</p>}

      {shownMine.length > 0 && (
        <section className={styles.group} aria-label="My computers">
          <div className={styles.groupHead}>
            <span className={rows.title}>My computers</span>
            <span className={styles.aside}>{countOnline(mine, remotes.checks)} of {mine.length} online</span>
          </div>
          <ul className={rows.list}>
            {shownMine.map((row) => {
              const c = row.record;
              const isRunning = connecting.has(row.key);
              const connectError = connectErrors[row.key] ?? null;
              if (c === null) {
                return (
                  <UnconnectedRow
                    key={row.key}
                    row={row}
                    running={isRunning}
                    error={connectError}
                    onConnect={() => void connect(row)}
                  />
                );
              }
              const check = remotes.checks[c.id];
              const checkError = remotes.checkErrors[c.id] ?? null;
              const again = row.machineId !== null && needsConnect(c, check);
              return (
                <RemoteComputerRow
                  key={row.key}
                  api={api}
                  computer={c}
                  check={check}
                  fallbackFocus={addButtonRef}
                  onChanged={() => void remotes.reload()}
                  onRecheck={() => void remotes.checkOne(c.id).then(() => remotes.reload())}
                  onRemoved={(id) => forget(row, id)}
                  arrowKeys
                  account={{
                    rowKey: row.key,
                    detail: isRunning ? 'Connecting…' : accountRowDetail(c, check, checkError !== null),
                    connect: again ? { running: isRunning, run: () => void connect(row) } : null,
                    alert: connectError ?? checkError,
                  }}
                />
              );
            })}
          </ul>
        </section>
      )}

      {view.state === 'ok' && mine.length === 0 && !query && <p className={rows.note}>{ONLY_THIS_ONE}</p>}

      {(shownLinks.length > 0 || shownWaiting.length > 0) && (
        <section className={styles.group} aria-label="Paired by link">
          <span className={rows.title}>Paired by link</span>
          {shownWaiting.map((w) => (
            <WaitingCard key={w.id} waiting={w} check={remotes.checks[w.id]} onDismiss={() => remotes.dismissWaiting(w.id)} />
          ))}
          {shownLinks.length > 0 && (
            <ul className={rows.list}>
              {shownLinks.map((c) => (
                <RemoteComputerRow
                  key={c.id}
                  api={api}
                  computer={c}
                  check={remotes.checks[c.id]}
                  fallbackFocus={addButtonRef}
                  onChanged={() => void remotes.reload()}
                  onRecheck={() => void remotes.checkOne(c.id).then(() => remotes.reload())}
                  onRemoved={remotes.removed}
                  arrowKeys
                />
              ))}
            </ul>
          )}
        </section>
      )}

      <div className={styles.group}>
        <AddComputer
          api={api}
          buttonRef={addButtonRef}
          onAdded={remotes.added}
          bare
          // Only with the account's computers listed, and not in Lite, which has no RESOURCES tab to go to.
          aside={view.state === 'ok' && !IS_LITE ? (
            <Link to={MACHINES_PATH} className={buttonClass({ variant: 'quiet', size: 'sm' })} onClick={onLeave}>
              Manage devices…
            </Link>
          ) : undefined}
        />
      </div>

      {remotes.loadError && <p className={rows.error} role="alert">{remotes.loadError}</p>}
    </div>
  );
}
