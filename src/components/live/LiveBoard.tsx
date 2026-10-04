/**
 * LiveBoard — the LIVE page on a desktop with the 3D scene off, once there
 * are sessions: a card per session, each opening its session panel, filters
 * for "what is busy" and "what is waiting on me", and the one-time tip above.
 *
 * Which sessions and in what order is lib/liveBoard.ts (the rail's order, so
 * nothing shuffles between the two); titles go through sessionDisplayTitle
 * and statuses through the rail's own names, colours and icons. Desktop only:
 * a phone gets RobotListSidebar, and LiveView does not mount this there.
 */
import { useCallback, useId, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from 'react';
import type { Session } from '@/types';
import { BOARD_FILTERS, boardCounts, holdOrder, matchesBoardFilter, needsYou, type BoardFilter } from '@/lib/liveBoard';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { statusColor, statusLabel } from '@/lib/sessionStatusStyle';
import { detectCli } from '@/lib/cliDetect';
import { openSessionPanel } from '@/lib/liveSession';
import { useLiveHint } from '@/hooks/useLiveBoard';
import StatusGlyph from '@/components/session/StatusGlyph';
import LiveHintCallout from './LiveHintCallout';
import styles from '@/styles/modules/LiveBoard.module.css';

const CLI_NAMES = { claude: 'Claude', codex: 'Codex' } as const;

const NO_MATCH_TEXT: Record<BoardFilter, string> = {
  all: 'No sessions to show.',
  working: 'Nothing is working right now.',
  'needs-you': 'Nothing needs you right now.',
};

interface LiveBoardProps {
  /** Already in board order (`boardSessions`). */
  sessions: Session[];
}

function BoardCard({ session, onOpen }: { session: Session; onOpen: (id: string) => void }) {
  const title = sessionDisplayTitle(session);
  const label = statusLabel(session.status);
  const project = session.projectName && session.projectName !== title ? session.projectName : '';
  const cli = detectCli(session);
  return (
    <li className={styles.cell}>
      <button
        type="button"
        className={styles.card}
        data-session-id={session.sessionId}
        data-status={session.status}
        data-needs-you={needsYou(session.status) ? 'true' : undefined}
        style={{ '--status-color': statusColor(session.status) } as CSSProperties}
        aria-label={[`Open ${title}`, label, project].filter(Boolean).join(' — ')}
        onClick={() => onOpen(session.sessionId)}
      >
        <span className={styles.cardTop}>
          <span className={styles.glyph}>
            <StatusGlyph status={session.status} />
          </span>
          <span className={styles.status}>{label}</span>
          {cli && <span className={styles.cli}>{CLI_NAMES[cli]}</span>}
        </span>
        <span className={styles.title}>{title}</span>
        {project && <span className={styles.project}>{project}</span>}
      </button>
    </li>
  );
}

export default function LiveBoard({ sessions }: LiveBoardProps) {
  const headingId = useId();
  const [filter, setFilter] = useState<BoardFilter>('all');
  const counts = useMemo(() => boardCounts(sessions), [sessions]);
  const filtered = useMemo(
    () => sessions.filter((s) => matchesBoardFilter(s.status, filter)),
    [sessions, filter],
  );
  // While the pointer or focus is on the cards, hold their order (lib/liveBoard.ts
  // `holdOrder`): a status change must not slide another card under a click.
  const [heldIds, setHeldIds] = useState<string[] | null>(null);
  const shown = useMemo(() => holdOrder(filtered, heldIds), [filtered, heldIds]);
  const onCards = useRef({ pointer: false, focus: false });
  const setOnCards = (where: 'pointer' | 'focus', on: boolean) => {
    onCards.current[where] = on;
    const hold = onCards.current.pointer || onCards.current.focus;
    setHeldIds((prev) => (hold ? (prev ?? shown.map((s) => s.sessionId)) : null));
  };
  const onCardsBlur = (e: FocusEvent<HTMLUListElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOnCards('focus', false);
  };
  const hint = useLiveHint(true);
  const { dismiss } = hint;

  // A card click is one of the three things the tip teaches, so it retires it.
  const open = useCallback((sessionId: string) => {
    dismiss();
    openSessionPanel(sessionId);
  }, [dismiss]);

  return (
    <section className={styles.board} aria-labelledby={headingId}>
      {hint.visible && <LiveHintCallout onDismiss={dismiss} />}

      <header className={styles.header}>
        <h2 id={headingId} className={styles.heading}>
          Sessions <span className={styles.headingCount}>({sessions.length})</span>
        </h2>
        <div className={styles.filters} role="group" aria-label="Show sessions">
          {BOARD_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={styles.filter}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}{' '}
              <span className={styles.filterCount}>{counts[id]}</span>
            </button>
          ))}
        </div>
      </header>

      {shown.length > 0 ? (
        <ul
          className={styles.grid}
          onPointerEnter={() => setOnCards('pointer', true)}
          onPointerLeave={() => setOnCards('pointer', false)}
          onFocus={() => setOnCards('focus', true)}
          onBlur={onCardsBlur}
        >
          {shown.map((session) => (
            <BoardCard key={session.sessionId} session={session} onOpen={open} />
          ))}
        </ul>
      ) : (
        <p className={styles.noMatch}>{NO_MATCH_TEXT[filter]}</p>
      )}
    </section>
  );
}
