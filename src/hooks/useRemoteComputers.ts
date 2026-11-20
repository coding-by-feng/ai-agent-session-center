/**
 * useRemoteComputers — the list of other AASC computers this app holds, their live checks, and the wait for Allow.
 *
 * Shared by `RemoteComputers` (the devices panel's link list, and the whole of a Client edition's home page) and by
 * the devices switcher (plan 18), which also holds computers connected through the AASC Cloud account. It was the
 * state of `RemoteComputers` until Nov 20 2026 and behaves as it did there:
 *
 * every row is checked when the list mounts and every 30 s while it stays mounted, never two checks of the same row
 * at once (`inFlight`), never a removed row. A computer just added is checked every 3 s until its owner answers, for
 * at most 10 minutes.
 *
 * Since the switcher, answers can cross a change made here, so three things hold (code review, Nov 20 2026):
 *   · several computers can wait for Allow at once (a link pairing and an account Connect), each for its own
 *     10 minutes, all asked by one 3 s timer;
 *   · a check that started before a record was replaced (`follow`) or forgotten (`removed`) is dropped when it
 *     lands, and does not hold up the fresh check of the new record (`generation`);
 *   · a list read before a pairing, a Connect or a removal is thrown away and read again (`listEpoch`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import { withRecord } from '@/lib/remoteComputerRows';
import type { RemoteComputer, RemoteComputerCheck, RemoteComputersAPI } from '@/types/electron';

/** How often every row is re-checked while the list is mounted. */
const CHECK_EVERY_MS = 30_000;
/** How often a computer waiting for Allow is asked again. */
const WAIT_POLL_MS = 3_000;
/** When to stop asking a computer whose owner never answered. */
const WAIT_GIVE_UP_MS = 10 * 60_000;

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A computer whose Allow is being waited for. Several can wait at once, each on its own clock. */
export interface Waiting {
  id: string;
  name: string;
  code: string | null;
  gaveUp: boolean;
  /** Connected through the account: its own row says it is waiting, so there is no card and no toast. */
  quiet: boolean;
  /** When this wait began (ms): it gives up 10 minutes later, whatever the others do. */
  startedAt: number;
}

export interface RemoteComputersOptions {
  /** A computer just answered Allow, or needed none. */
  onAllowed?: (id: string) => void;
  /** The app brought the list back on screen (a Client's home page); returns how to stop listening. */
  onShown?: (listener: () => void) => () => void;
}

export interface RemoteComputersState {
  /** Null until the first read. */
  computers: RemoteComputer[] | null;
  checks: Record<string, RemoteComputerCheck>;
  /** By record id: why its last check was refused (not merely unanswered), as given. Gone once a check answers. */
  checkErrors: Record<string, string>;
  loadError: string | null;
  /** Every computer being waited for, oldest first. */
  waiting: Waiting[];
  reload: () => Promise<RemoteComputer[] | null>;
  /** One check of one row; null when that row is already being checked, or the answer was about a replaced record. */
  checkOne: (id: string) => Promise<RemoteComputerCheck | null>;
  /** A computer was just paired by link. */
  added: (c: RemoteComputer) => void;
  /** `accountConnect` just answered this record: show it at once, and wait for Allow when it is pending. */
  follow: (c: RemoteComputer) => void;
  removed: (id: string) => void;
  /** Stop the 3 s asking for one computer (its card's Dismiss); it stays in the list. */
  dismissWaiting: (id: string) => void;
}

function without<T>(map: Record<string, T>, id: string): Record<string, T> {
  if (!(id in map)) return map;
  return Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
}

export function useRemoteComputers(api: RemoteComputersAPI, options: RemoteComputersOptions = {}): RemoteComputersState {
  const { onAllowed, onShown } = options;
  const [computers, setComputers] = useState<RemoteComputer[] | null>(null);
  const [checks, setChecks] = useState<Record<string, RemoteComputerCheck>>({});
  const [checkErrors, setCheckErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  /** The same list, for the one poll timer, which must read it as it is now. */
  const waits = useRef<Waiting[]>([]);
  /** `<id>#<generation>` of every check that is out. */
  const inFlight = useRef(new Set<string>());
  /**
   * By record id: raised when the record is replaced (`follow`) or forgotten (`removed`). A check that started
   * before that is about the old record: its answer is dropped, and it does not hold up a fresh check.
   */
  const generation = useRef(new Map<string, number>());
  /** Raised by every change made here (a pairing, a Connect, a removal): a list read before it would undo it. */
  const listEpoch = useRef(0);

  const changeWaits = useCallback((change: (list: Waiting[]) => Waiting[]) => {
    waits.current = change(waits.current);
    setWaiting(waits.current);
  }, []);

  const reload = useCallback(async (): Promise<RemoteComputer[] | null> => {
    for (;;) {
      const epoch = listEpoch.current;
      try {
        const list = await api.list();
        // Read before a change made here: it would drop a record just connected, or bring back one just removed.
        if (epoch !== listEpoch.current) continue;
        setComputers(list);
        setLoadError(null);
        return list;
      } catch (err) {
        setLoadError(errorText(err));
        return null;
      }
    }
  }, [api]);

  const checkOne = useCallback(async (id: string): Promise<RemoteComputerCheck | null> => {
    const started = generation.current.get(id) ?? 0;
    const flight = `${id}#${started}`;
    if (inFlight.current.has(flight)) return null;
    inFlight.current.add(flight);
    let next: RemoteComputerCheck;
    let refused: string | null = null;
    try {
      const res = await api.check(id);
      if (!res.ok) refused = res.error;
      next = res.ok ? res.data : { state: 'offline', via: null, sharedSessions: null, message: res.error };
    } catch (err) {
      refused = errorText(err);
      next = { state: 'offline', via: null, sharedSessions: null, message: refused };
    } finally {
      inFlight.current.delete(flight);
    }
    if ((generation.current.get(id) ?? 0) !== started) return null;
    const why = refused;
    setChecks((prev) => ({ ...prev, [id]: next }));
    setCheckErrors((prev) => (why === null ? without(prev, id) : prev[id] === why ? prev : { ...prev, [id]: why }));
    return next;
  }, [api]);

  /** What this hook knew about a record is about one it no longer holds. */
  const forgetAnswers = useCallback((id: string) => {
    generation.current.set(id, (generation.current.get(id) ?? 0) + 1);
    listEpoch.current += 1;
    setChecks((prev) => without(prev, id));
    setCheckErrors((prev) => without(prev, id));
  }, []);

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
    const stopListening = onShown?.(() => void round());
    return () => {
      alive = false;
      clearInterval(timer);
      stopListening?.();
    };
  }, [reload, checkOne, onShown]);

  // One timer asks every computer that is being waited for, each until its own 10 minutes are up.
  const anyWaiting = waiting.some((w) => !w.gaveUp);
  useEffect(() => {
    if (!anyWaiting) return undefined;
    let alive = true;
    const timer = setInterval(() => {
      const now = Date.now();
      for (const w of waits.current) {
        if (w.gaveUp) continue;
        const isThis = (x: Waiting) => x.id === w.id && x.startedAt === w.startedAt;
        if (now - w.startedAt >= WAIT_GIVE_UP_MS) {
          // A link pairing keeps its card, which says it stopped; an account row goes on saying it waits.
          changeWaits((list) => (w.quiet ? list.filter((x) => !isThis(x)) : list.map((x) => (isThis(x) ? { ...x, gaveUp: true } : x))));
          continue;
        }
        void checkOne(w.id).then((res) => {
          // Offline is not an answer: the other computer may just be asleep for a moment.
          if (!alive || !res || res.state === 'pending' || res.state === 'offline') return;
          changeWaits((list) => list.filter((x) => !isThis(x)));
          void reload();
          if (!w.quiet) {
            showToast(res.state === 'online' ? `${w.name} is paired` : `${w.name} refused this computer`, 'info', 3000);
          }
          if (res.state === 'online') onAllowed?.(w.id);
        });
      }
    }, WAIT_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [anyWaiting, onAllowed, checkOne, reload, changeWaits]);

  const waitFor = useCallback((c: RemoteComputer, quiet: boolean) => {
    const wait: Waiting = { id: c.id, name: c.name, code: c.confirmCode, gaveUp: false, quiet, startedAt: Date.now() };
    changeWaits((list) => [...list.filter((x) => x.id !== c.id), wait]);
  }, [changeWaits]);

  const added = useCallback((c: RemoteComputer) => {
    listEpoch.current += 1;
    if (c.status === 'pending') waitFor(c, false);
    else {
      showToast(`${c.name} is paired`, 'info', 3000);
      onAllowed?.(c.id);
    }
    void reload().then(() => checkOne(c.id));
  }, [onAllowed, reload, checkOne, waitFor]);

  const follow = useCallback((c: RemoteComputer) => {
    // What was known about this id was about the record this one replaces; a check still out for it is dropped.
    forgetAnswers(c.id);
    setComputers((list) => withRecord(list, c));
    if (c.status === 'pending') waitFor(c, true);
    else changeWaits((list) => list.filter((x) => x.id !== c.id));
    void checkOne(c.id).then(() => reload());
  }, [checkOne, reload, forgetAnswers, waitFor, changeWaits]);

  const removed = useCallback((id: string) => {
    forgetAnswers(id);
    setComputers((list) => list?.filter((c) => c.id !== id) ?? list);
    changeWaits((list) => list.filter((x) => x.id !== id));
  }, [forgetAnswers, changeWaits]);

  const dismissWaiting = useCallback((id: string) => changeWaits((list) => list.filter((x) => x.id !== id)), [changeWaits]);

  return { computers, checks, checkErrors, loadError, waiting, reload, checkOne, added, follow, removed, dismissWaiting };
}
