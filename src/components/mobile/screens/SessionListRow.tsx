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
 * running tool, the start of the last answer), and project · room · label.
 *
 * With `swipeActions` the row swipes left to reveal them; with `menuItems` a
 * press-and-hold (or right click, Shift+F10) opens them as a menu. The swipe is
 * never the only way: the menu repeats its actions.
 */
import type { CSSProperties } from 'react';
import type { Session } from '@/types';
import { ContextMenu, StatusRing, SwipeRow } from '../kit';
import type { ContextMenuItem, SwipeAction } from '../kit';
import { ChevronRightIcon } from '../kit/kitIcons';
import { ClaudeIcon, CodexIcon } from '@/components/layout/CliBrandIcons';
import { useRoomStore } from '@/stores/roomStore';
import { useLabelStore } from '@/stores/labelStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { phoneStatus } from '@/lib/chat/phoneStatus';
import { formatAge, nowLine } from '@/lib/chat/sessionsModel';
import { roomColor } from '@/lib/roomColor';
import { detectCli } from '@/lib/cliDetect';
import { useClock } from '@/lib/chat/clock';
import styles from '@/styles/modules/mobile/Sessions.module.css';

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
}: SessionListRowProps) {
  const room = useRoomStore((s) => (hideRoom ? undefined : s.rooms.find((r) => r.sessionIds.includes(session.sessionId))));
  const label = useLabelStore((s) => s.labels[session.sessionId]);
  const clock = useClock();
  const labelColor = useLabelStore((s) => (label ? s.labelColor(label) : undefined));
  const title = sessionDisplayTitle(session);
  const status = phoneStatus(session.status, !!session.interruption).label;
  const line = detail ?? nowLine(session);
  const age = formatAge((now ?? clock) - (session.lastActivityAt ?? 0));
  const cli = detectCli(session);
  const project = !hideProject && session.projectName && session.projectName !== title ? session.projectName : null;
  const cliWord = cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : null;
  const spoken = [title, cliWord, status, line, project, room ? `room ${room.name}` : null, label ? `label ${label}` : null, age === 'now' ? 'active now' : `${age} ago`]
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
        <StatusRing status={session.status} interrupted={!!session.interruption} />
        <CliMark cli={cli} />
      </span>
      <span className={styles.text}>
        <span className={styles.top}>
          <span className={styles.title}>{title}</span>
          <span className={styles.age}>{age}</span>
        </span>
        {line && <span className={styles.line}>{line}</span>}
        {(project || room || label) && (
          <span className={styles.meta}>
            {project && <span className={styles.project}>{project}</span>}
            {room && (
              <span className={styles.roomChip} style={{ '--room-color': roomColor(room) } as CSSProperties}>
                {room.name}
              </span>
            )}
            {label && (
              <span className={styles.labelChip} style={{ '--label-color': labelColor } as CSSProperties}>
                {label}
              </span>
            )}
          </span>
        )}
      </span>
      <span className={styles.chevron} aria-hidden="true"><ChevronRightIcon /></span>
    </button>
  );

  const withMenu = menuItems?.length
    ? <ContextMenu items={menuItems} label={`Actions for ${title}`}>{button}</ContextMenu>
    : button;
  return (
    <li className={styles.item}>
      {swipeActions?.length ? <SwipeRow actions={swipeActions}>{withMenu}</SwipeRow> : withMenu}
    </li>
  );
}
