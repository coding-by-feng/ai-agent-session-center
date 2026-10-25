/**
 * InboxScreen — the Inbox tab (AASC-43): everything waiting across sessions,
 * answerable in place.
 *
 *   Inbox                                   Mark all read
 *   (Waiting 3) (Finished 5) (All)
 *   ⚠ agent-manager-2 · 2m   Wants to run: npm run build   [Deny] [Allow once]
 *   ? exmouth-erp-1 · 5m     Which payment phase applies?  (Deposit) (Stage 2) (Other…)
 *   ⟳ aasc-backend-1 · 1m    Stopped: API Error: 529       [Continue]
 *   ✓ website-1 · 12m        "Updated the pricing page…"
 *
 * A central's confirmations (AASC P5-15) wait above the filter chips, in every filter: they expire on their own
 * and count as denied, so they are never filtered away. Oldest first, so a new card never moves an older one's buttons.
 *
 * Built only from what the phone already receives (lib/chat/inboxItems). After
 * AASC restarts, the sessions it cut off come as one "Continue" item. A row
 * opens its session on this tab's own stack, so back returns here (the triage
 * loop). "Read" is this phone's own. Nothing here is answerable from the lock
 * screen: notifications only open the app.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Session } from '@/types';
import { Button, Chip, EmptyState, Screen } from '../kit';
import { InboxTabIcon } from '../kit/kitIcons';
import ConnectionBanner from './ConnectionBanner';
import InboxItemRow from '../chat/InboxItemRow';
import { PhoneConfirmList } from '../chat/PhoneConfirmCard';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneConfirmStore } from '@/stores/phoneConfirmStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { sessionHasChat, sessionPath } from '@/lib/chat/phoneRoutes';
import { detectCli } from '@/lib/cliDetect';
import {
  filterInbox,
  inboxItems,
  loadReadState,
  markRead,
  saveReadState,
  unreadCount,
  waitingCount,
  type InboxFilter,
  type InboxItem,
  type ReadState,
} from '@/lib/chat/inboxItems';
import { CONTINUE_AFTER_RESTART_PROMPT, dismissInterrupted, getInterruptedOffer, subscribeInterrupted } from '@/lib/interruptedRestore';
import { DEFAULT_RESUME_PROMPT } from '@/lib/resumeWatchdog';
import { promptOutcome, sendPrompt, waitForPrompt } from '@/lib/chat/promptApi';
import { showToast } from '@/components/ui/ToastContainer';
import styles from '@/styles/modules/mobile/Inbox.module.css';

const TICK_MS = 30_000;
const plural = (n: number) => `${n} session${n === 1 ? '' : 's'}`;

/** "now", "2m"… stay current while the screen is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Continue one or several stopped sessions through the Mac's confirmed send. */
function useContinue(sessions: ReadonlyMap<string, Session>) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const run = useCallback(async (item: InboxItem) => {
    setBusy((prev) => new Set(prev).add(item.id));
    const text = item.reason === 'restart' ? CONTINUE_AFTER_RESTART_PROMPT : DEFAULT_RESUME_PROMPT;
    const results = await Promise.all(item.sessionIds.map(async (sessionId) => ({ sessionId, result: await sendPrompt(sessionId, { text, mode: 'now' }) })));
    setBusy((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    if (item.reason === 'restart') dismissInterrupted();
    const name = (sid: string) => {
      const s = sessions.get(sid);
      return s ? sessionDisplayTitle(s) : 'a session';
    };
    const refused = results.flatMap((r) => (r.result.ok ? [] : [{ sessionId: r.sessionId, message: r.result.error.message }]));
    if (refused.length === 0) showToast(`Sent “continue” to ${plural(results.length)}`, 'success', 3000);
    else if (results.length === 1) showToast(refused[0].message, 'error', 5000);
    else showToast(`Couldn’t continue ${refused.map((r) => name(r.sessionId)).join(', ')}. Open them to see why.`, 'error', 6000);
    // What became of each one: only a failure needs saying.
    for (const r of results) {
      if (!r.result.ok) continue;
      const { key } = r.result;
      void waitForPrompt(r.sessionId, key).then((final) => {
        const outcome = promptOutcome(final);
        if (!outcome.ok) showToast(`${name(r.sessionId)}: ${outcome.message}`, outcome.unsure ? 'info' : 'error', 6000);
      });
    }
  }, [sessions]);
  return { busy, run };
}

export default function InboxScreen() {
  const sessions = useSessionStore((s) => s.sessions);
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const push = usePhoneNavStore((s) => s.push);
  const openTerminal = usePhoneNavStore((s) => s.openTerminal);
  const confirms = usePhoneConfirmStore((s) => s.confirms);
  const pruneConfirms = usePhoneConfirmStore((s) => s.prune);
  const offer = useSyncExternalStore(subscribeInterrupted, getInterruptedOffer, () => null);
  const now = useNow();
  const [filter, setFilter] = useState<InboxFilter>('waiting');
  const [read, setRead] = useState<ReadState>(loadReadState);
  const { busy, run } = useContinue(sessions);

  const items = useMemo(
    () => inboxItems(sessions, { titleOf: sessionDisplayTitle, now, offer }),
    [sessions, now, offer],
  );
  const waiting = useMemo(() => filterInbox(items, 'waiting'), [items]);
  const finished = useMemo(() => filterInbox(items, 'finished'), [items]);
  const shown = filter === 'waiting' ? waiting : filter === 'finished' ? finished : items;
  const unread = unreadCount(items, read);

  const updateRead = useCallback((ids: readonly string[]) => {
    setRead((prev) => {
      const next = markRead(prev, ids, Date.now());
      saveReadState(next);
      return next;
    });
  }, []);
  const onRead = useCallback((id: string) => updateRead([id]), [updateRead]);
  const open = useCallback((sessionId: string, segment: 'chat' | 'terminal' = 'chat') => {
    if (segment === 'chat') {
      push(sessionPath(sessionId, 'chat'));
      return;
    }
    // The terminal is a screen over the session's Chat (AASC-56), so Back lands on Chat.
    const target = useSessionStore.getState().sessions.get(sessionId);
    openTerminal(sessionId, target ? sessionHasChat(detectCli(target)) : true);
  }, [push, openTerminal]);

  const markAll = (
    <Button small variant="plain" onClick={() => updateRead(items.map((i) => i.id))}>Mark all read</Button>
  );

  return (
    <Screen title="Inbox" banner={<ConnectionBanner />} actions={unread > 0 ? markAll : undefined} testId="phone-inbox">
      <PhoneConfirmList confirms={confirms} onExpired={pruneConfirms} />
      <div className={styles.filters} role="group" aria-label="Show">
        <Chip label="Waiting" count={waitingCount(items)} selected={filter === 'waiting'} onClick={() => setFilter('waiting')} />
        <Chip label="Finished" count={finished.length} selected={filter === 'finished'} onClick={() => setFilter('finished')} />
        <Chip label="All" selected={filter === 'all'} onClick={() => setFilter('all')} />
      </div>
      {!snapshotReceived ? (
        <EmptyState live title="Loading…" />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<InboxTabIcon />}
          title={filter === 'finished' ? 'No finished turns' : filter === 'waiting' ? (confirms.length > 0 ? 'Nothing else needs you' : 'Nothing needs you') : 'Nothing here yet'}
          message={filter === 'finished'
            ? 'Turns that ended in the last 12 hours show up here.'
            : 'Approvals, questions and turns that stopped show up here.'}
          action={filter === 'waiting' && finished.length > 0
            ? <Button onClick={() => setFilter('finished')}>See {finished.length} finished</Button>
            : undefined}
        />
      ) : (
        <ul className={styles.list} aria-label={filter === 'waiting' ? 'Waiting for you' : filter === 'finished' ? 'Finished turns' : 'Everything'}>
          {shown.map((item) => (
            <InboxItemRow
              key={item.id}
              item={item}
              session={item.sessionId ? sessions.get(item.sessionId) : undefined}
              now={now}
              unread={read[item.id] === undefined}
              onOpen={open}
              onRead={onRead}
              onContinue={(i) => void run(i)}
              continuing={busy.has(item.id)}
            />
          ))}
        </ul>
      )}
    </Screen>
  );
}
