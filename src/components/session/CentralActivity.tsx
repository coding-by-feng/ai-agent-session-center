/**
 * CentralActivity — the ACTIVITY tab of a central session (server/mcp): what the central did, newest first.
 *
 *   14:05:09   prompt_send    Backend worker    ok
 *              Sent a prompt to 1 session
 *
 * Every write the central made, every request AASC refused, and every change of a task it handed out (tool
 * `task`, the state it moved to as its outcome) is a row: time · tool · target · outcome, and AASC's own one-line
 * summary under it. Nothing a session wrote and no argument the central sent is in a row (the server keeps those
 * out of the log), so every word here is shown as plain text.
 *
 * It reads the log when it opens (GET /api/mcp/activity for its central, through `mcpStore.loadActivity`) and
 * then follows the `mcp_activity` feed through the same store, so a row that arrives while the tab is open is at
 * the top at once. The feed is not replayed, so it reads again whenever the socket comes back after a drop. A read
 * that fails is said so, with a Retry; rows the feed brought are shown either way, with a note that older ones
 * could not be read.
 *
 * It is a record to read, not a control: nothing in a row is clickable (a target that looked clickable and was not
 * would be a lie). The target is named as its card names it and follows a rename; a session that has left the
 * board shows its first 8 characters, with the whole id on hover.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import { useMcpStore } from '@/stores/mcpStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { activityOutcomeLabel, activityOutcomeTone, activityTargetLabel, activityTime } from '@/lib/centralActivity';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import type { McpActivityRow } from '@/types';
import styles from '@/styles/modules/CentralActivity.module.css';

interface CentralActivityProps {
  /** The central whose log this is. */
  centralId: string;
}

interface RowProps {
  row: McpActivityRow;
  now: number;
  targetText: string;
  targetKnown: boolean;
}

/** One row. Memoised: a row never changes, so a new one at the top does not redraw the rest. */
const ActivityRowItem = memo(function ActivityRowItem({ row, now, targetText, targetKnown }: RowProps) {
  const time = activityTime(row.at, now);
  // The store takes any finite number for a row's time, and a finite number can be out of range for a Date, whose
  // toISOString then throws: such a row reads "—" (as activityTime says) and carries no machine-readable time.
  const at = new Date(row.at);
  const dateTime = Number.isNaN(at.getTime()) ? undefined : at.toISOString();
  return (
    <li className={styles.row}>
      <time className={styles.time} dateTime={dateTime} title={time.title}>
        {time.text}
      </time>
      <span className={styles.tool} title={`${row.tool} (${row.risk})`}>{row.tool}</span>
      <span
        className={targetKnown ? styles.target : `${styles.target} ${styles.targetGone}`}
        title={row.targetSessionId ?? undefined}
      >
        {targetText}
      </span>
      <Chip tone={activityOutcomeTone(row.outcome)} className={styles.outcome}>
        {activityOutcomeLabel(row.outcome)}
      </Chip>
      <span className={styles.summary}>{row.summary}</span>
    </li>
  );
});

export default function CentralActivity({ centralId }: CentralActivityProps) {
  const loadActivity = useMcpStore((s) => s.loadActivity);
  const all = useMcpStore((s) => s.activity);
  // "Today" for the times is the day the tab opened: a row of a later day just shows its date as well.
  const [now] = useState(() => Date.now());

  // One read per (central, attempt). The answer is kept with the read it belongs to, so the answer of a read that
  // was overtaken (another central opened, or a retry) never decides what the current one shows.
  const [attempt, setAttempt] = useState(0);
  const readKey = `${centralId}#${attempt}`;
  const [read, setRead] = useState<{ key: string; ok: boolean } | null>(null);
  // The first read and the one after a reconnect share a key, so the key alone cannot tell them apart: each read
  // takes a number, and only the newest one started may answer (an older one that finishes later is stale, whether
  // it failed or not).
  const newestRead = useRef(0);
  useEffect(() => {
    let current = true;
    const readLog = () => {
      newestRead.current += 1;
      const mine = newestRead.current;
      void loadActivity(centralId).then((ok) => {
        if (current && mine === newestRead.current) setRead({ key: readKey, ok });
      });
    };
    readLog();
    // The feed is never replayed, so a row the central wrote while the socket was down reaches the store only through
    // a read: read again each time the socket comes back. Under the same key, so the rows on screen stay while it
    // does and the new answer replaces the last one.
    const stopWatching = useWsStore.subscribe((state, before) => {
      if (state.connected && !before.connected) readLog();
    });
    return () => {
      current = false;
      stopWatching();
    };
  }, [centralId, readKey, loadActivity]);
  const status = read?.key === readKey ? (read.ok ? 'ready' : 'error') : 'loading';

  const rows = useMemo(() => all.filter((r) => r.centralId === centralId), [all, centralId]);

  // The names of the sessions the rows are about, as their cards say them. Shallow-compared strings, so a session
  // update that renames nobody does not redraw the list.
  const targetIds = useMemo(
    () => [...new Set(rows.flatMap((r) => (r.targetSessionId === null ? [] : [r.targetSessionId])))],
    [rows],
  );
  const names = useSessionStore(
    useShallow((s) => {
      const out: Record<string, string> = {};
      for (const id of targetIds) {
        const found = s.sessions.get(id);
        if (found) out[id] = sessionDisplayTitle(found);
      }
      return out;
    }),
  );
  const titled = useMemo(() => new Map(Object.entries(names).map(([id, title]) => [id, { title }])), [names]);

  const retry = <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Retry</Button>;

  if (rows.length === 0) {
    return (
      <div className={styles.root}>
        {status === 'loading' && <EmptyState compact busy title="Loading activity…" />}
        {status === 'error' && <EmptyState compact tone="error" title="Could not load the activity log." action={retry} />}
        {status === 'ready' && (
          <EmptyState
            compact
            title="No activity yet"
            hint="What this central writes, and the requests AASC refuses, are listed here as they happen."
          />
        )}
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <p className={styles.note}>
        What this central wrote and what AASC refused, newest first. Kept for 30 days.
      </p>
      <ul className={styles.list}>
        {rows.map((row) => {
          const target = activityTargetLabel(row.targetSessionId, titled);
          return <ActivityRowItem key={row.id} row={row} now={now} targetText={target.text} targetKnown={target.known} />;
        })}
      </ul>
      {status === 'error' && (
        <p className={styles.note} role="status">
          Older rows could not be loaded. {retry}
        </p>
      )}
    </div>
  );
}
