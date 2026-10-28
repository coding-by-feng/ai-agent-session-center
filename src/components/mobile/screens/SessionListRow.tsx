/**
 * SessionListRow — one session in a phone list (AASC-40):
 *
 *   (◉)  agent-manager-2                         2m
 *    C   Wants to run: npm run build
 *        agent-manager · [Mobile] · IMPORTANT
 *
 * The CLI's mark (Claude / Codex) sits on a status ring that carries the status
 * glyph too (never colour alone); then the display title, how long since it
 * last did something, the one line that matters now (the pending ask, the
 * running tool, the start of the last answer), and project · room. No label: labels are
 * each device's own (labelStore never syncs), so the phone shows none (Oct 20 2026).
 * Before the age, a ≣ N pill when prompts wait in its queue (Oct 21 2026): the
 * shared queueStore's count, as the desktop rail shows it; none when empty.
 * A central session (server/mcp) carries a ★ before its title, as its desktop
 * rail card does, and its scope in the row's name (Oct 27 2026).
 *
 * With `swipeActions` the row swipes left to reveal them; with `menuItems` a
 * press-and-hold (or right click, Shift+F10) opens them as a menu. The swipe is
 * never the only way: the menu repeats its actions. With `grip` (grouped by
 * room) a ≡ before the row drags it into another room (AASC-55).
 */
import type { CSSProperties } from 'react';
import type { Session } from '@/types';
import { ContextMenu, StatusRing, SwipeRow } from '../kit';
import type { ContextMenuItem, SwipeAction } from '../kit';
import { ChevronRightIcon, QueueTabIcon } from '../kit/kitIcons';
import { ClaudeIcon, CodexIcon } from '@/components/layout/CliBrandIcons';
import { useRoomStore } from '@/stores/roomStore';
import { useQueueStore } from '@/stores/queueStore';
import { useCentralSessionsShown } from '@/stores/centralFeatureStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { isCompacting, phoneStatus } from '@/lib/chat/phoneStatus';
import { displayStatus } from '@/lib/sessionStatusStyle';
import { formatAge, nowLine } from '@/lib/chat/sessionsModel';
import { roomColor } from '@/lib/roomColor';
import { detectCli } from '@/lib/cliDetect';
import { centralLabel } from '@/lib/centralChoice';
import { useClock } from '@/lib/chat/clock';
import type { GripHandlers } from './useSessionRoomDrag';
import styles from '@/styles/modules/mobile/Sessions.module.css';
import roomStyles from '@/styles/modules/mobile/SessionRooms.module.css';

export interface SessionListRowProps {
  session: Session;
  /** The line under the title; default: what matters now (`nowLine`). */
  detail?: string;
  onOpen: (session: Session) => void;
  /** The clock the age is measured against; default: the shared phone clock. */
  now?: number;
  /** Leave the project out (a list grouped by project says it already). */
  hideProject?: boolean;
  /** Leave the room out (a list grouped by room says it already). */
  hideRoom?: boolean;
  swipeActions?: ReadonlyArray<SwipeAction>;
  menuItems?: ReadonlyArray<ContextMenuItem>;
  /** A grip before the row (Sessions grouped by room, AASC-55): hold and drag
   *  it into another room, or tap it for "Move to room…". Always shown, never
   *  revealed on hover, so the row never moves under a finger. */
  grip?: GripHandlers;
  /** This row is being dragged: it follows the finger by `dragY` px. */
  dragY?: number;
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 8h14M5 12h14M5 16h14" />
    </svg>
  );
}

function CliMark({ cli }: { cli: string | null }) {
  if (cli === 'claude') return <span className={styles.cli} data-cli="claude" aria-hidden="true"><ClaudeIcon size={12} /></span>;
  if (cli === 'codex') return <span className={styles.cli} data-cli="codex" aria-hidden="true"><CodexIcon size={12} /></span>;
  return null;
}

export default function SessionListRow({
  session,
  detail,
  onOpen,
  now,
  hideProject,
  hideRoom,
  swipeActions,
  menuItems,
  grip,
  dragY,
}: SessionListRowProps) {
  const room = useRoomStore((s) => (hideRoom ? undefined : s.rooms.find((r) => r.sessionIds.includes(session.sessionId))));
  // A string or undefined, as CentralBadge reads it: re-renders only when that room is renamed.
  const centralRoomName = useRoomStore((s) =>
    session.central?.kind === 'room' ? s.rooms.find((r) => r.id === session.central?.scopeRef)?.name : undefined,
  );
  // No ★ while central sessions are off: the marker stays, for when they are on again (centralFeatureStore).
  const central = useCentralSessionsShown() ? session.central : undefined;
  const queued = useQueueStore((s) => s.queues.get(session.sessionId)?.length ?? 0);
  const clock = useClock();
  const title = sessionDisplayTitle(session);
  const shown = displayStatus(session); // the P while the last answer asks you to proceed
  const status = phoneStatus(shown, !!session.interruption, isCompacting(session)).label;
  const line = detail ?? nowLine(session);
  const age = formatAge((now ?? clock) - (session.lastActivityAt ?? 0));
  const cli = detectCli(session);
  const project = !hideProject && session.projectName && session.projectName !== title ? session.projectName : null;
  const cliWord = cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : null;
  const queuedWords = queued > 0 ? `${queued} queued prompt${queued === 1 ? '' : 's'}` : null;
  const centralWords = central ? centralLabel(central, centralRoomName) : null;
  const spoken = [title, centralWords, cliWord, status, line, project, room ? `room ${room.name}` : null, queuedWords, age === 'now' ? 'active now' : `${age} ago`]
    .filter(Boolean)
    .join(', ');

  const button = (
    <button
      type="button"
      className={styles.row}
      onClick={() => onOpen(session)}
      aria-label={spoken}
      data-testid={`session-row-${session.sessionId}`}
    >
      <span className={styles.avatar}>
        <StatusRing status={shown} interrupted={!!session.interruption} />
        <CliMark cli={cli} />
      </span>
      <span className={styles.text}>
        <span className={styles.top}>
          {central && (
            <span className={styles.central} aria-hidden="true" data-testid={`session-central-${session.sessionId}`}>★</span>
          )}
          <span className={styles.title}>{title}</span>
          {queued > 0 && (
            <span className={styles.queueCount} aria-hidden="true" data-testid={`session-queue-${session.sessionId}`}>
              <QueueTabIcon size={12} strokeWidth={2.2} />
              {queued}
            </span>
          )}
          <span className={styles.age}>{age}</span>
        </span>
        {line && <span className={styles.line}>{line}</span>}
        {(project || room) && (
          <span className={styles.meta}>
            {project && <span className={styles.project}>{project}</span>}
            {room && (
              <span className={styles.roomChip} style={{ '--room-color': roomColor(room) } as CSSProperties}>
                {room.name}
              </span>
            )}
          </span>
        )}
      </span>
      <span className={styles.chevron} aria-hidden="true"><ChevronRightIcon /></span>
    </button>
  );

  const withGrip = grip ? (
    <div className={roomStyles.gripRow}>
      <button
        type="button"
        className={roomStyles.grip}
        aria-label={`Move ${title} to another room: hold and drag it onto a room, or tap to choose`}
        aria-haspopup="dialog"
        data-testid={`session-grip-${session.sessionId}`}
        {...grip}
      >
        <GripIcon />
      </button>
      {button}
    </div>
  ) : button;
  const withMenu = menuItems?.length
    ? <ContextMenu items={menuItems} label={`Actions for ${title}`}>{withGrip}</ContextMenu>
    : withGrip;
  const dragging = dragY !== undefined;
  return (
    <li
      className={styles.item}
      data-grip={grip ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      style={dragging ? ({ '--drag-y': `${dragY}px` } as CSSProperties) : undefined}
    >
      {swipeActions?.length ? <SwipeRow actions={swipeActions}>{withMenu}</SwipeRow> : withMenu}
    </li>
  );
}
