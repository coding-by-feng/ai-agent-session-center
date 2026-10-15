/**
 * LiveBoard — the LIVE page on a desktop with the 3D scene off, once there
 * are sessions: a card per session, each opening its session panel, filters
 * for "what is busy" and "what is waiting on me", and the one-time tip above.
 *
 * Which sessions and in what order is lib/liveBoard.ts (the rail's order, so
 * nothing shuffles between the two); titles go through sessionDisplayTitle
 * and statuses through the rail's own names, colours and icons. A card also
 * carries its room (the strip's colour for it), a note (the user's remark, else
 * the last prompt a person typed) and how long a quiet session has been quiet.
 */
import { useCallback, useId, useMemo, useRef, useState, type CSSProperties, type FocusEvent } from 'react';
import type { Session } from '@/types';
import {
  BOARD_FILTERS,
  boardCounts,
  boardNote,
  cardRoom,
  holdOrder,
  matchesBoardFilter,
  needsYou,
  quietFor,
  roomBySession,
  type BoardFilter,
  type CardRoom,
} from '@/lib/liveBoard';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { statusColor, statusLabel } from '@/lib/sessionStatusStyle';
import { detectCli } from '@/lib/cliDetect';
import { openSessionPanel } from '@/lib/liveSession';
import { useBoardClock, useLiveHint } from '@/hooks/useLiveBoard';
import { useRoomStore } from '@/stores/roomStore';
import StatusBadge from '@/components/session/StatusBadge';
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

interface BoardCardProps {
  session: Session;
  room: CardRoom | null;
  /** The board's clock, for "quiet for". */
  now: number;
  onOpen: (id: string) => void;
}

function BoardCard({ session, room, now, onOpen }: BoardCardProps) {
  const noteId = useId();
  const title = sessionDisplayTitle(session);
  const label = statusLabel(session.status);
  const project = session.projectName && session.projectName !== title ? session.projectName : '';
  const cli = detectCli(session);
  const quiet = quietFor(session, now);
  const note = boardNote(session);
  // The name leads with the title and carries the status, project, room and age
  // shown on the card (the CLI name is not in it, as before); the note is long,
  // so it describes the card instead of joining its name.
  const name = [
    `Open ${title}`,
    label,
    project,
    room && `Room ${room.name}`,
    quiet && `quiet for ${quiet}`,
  ].filter(Boolean).join(' — ');
  return (
    <li className={styles.cell}>
      <button
        type="button"
        className={styles.card}
        data-session-id={session.sessionId}
        data-status={session.status}
        data-needs-you={needsYou(session.status) ? 'true' : undefined}
        style={{ '--status-color': statusColor(session.status) } as CSSProperties}
        aria-label={name}
        aria-describedby={note ? noteId : undefined}
        onClick={() => onOpen(session.sessionId)}
      >
        <span className={styles.cardTop}>
          <span className={styles.statusLine}>
            <StatusBadge status={session.status} label={label} className={styles.status} />
            {quiet && <span className={styles.age}>{quiet}</span>}
          </span>
          {/* Only the exception is marked: nearly every card is Claude (AASC-11). */}
          {cli && cli !== 'claude' && <span className={styles.cli}>{CLI_NAMES[cli]}</span>}
        </span>
        <span className={styles.title}>{title}</span>
        {note && (
          <span id={noteId} className={styles.note} data-kind={note.kind}>
            {note.text}
          </span>
        )}
        {(project || room) && (
          <span className={styles.footer}>
            {project && <span className={styles.project}>{project}</span>}
            {room && (
              <span
                className={styles.room}
                style={room.color ? ({ '--room-color': room.color } as CSSProperties) : undefined}
              >
                <span className={styles.roomDot} aria-hidden="true" />
                <span className={styles.roomName}>{room.name}</span>
              </span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}

export default function LiveBoard({ sessions }: LiveBoardProps) {
  const headingId = useId();
  const [filter, setFilter] = useState<BoardFilter>('all');
  const counts = useMemo(() => boardCounts(sessions), [sessions]);
  const rooms = useRoomStore((s) => s.rooms);
  const roomOf = useMemo(() => roomBySession(rooms), [rooms]);
  const now = useBoardClock();
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
            <BoardCard
              key={session.sessionId}
              session={session}
              room={cardRoom(roomOf.get(session.sessionId), rooms.length > 0)}
              now={now}
              onOpen={open}
            />
          ))}
        </ul>
      ) : (
        <p className={styles.noMatch}>{NO_MATCH_TEXT[filter]}</p>
      )}
    </section>
  );
}
