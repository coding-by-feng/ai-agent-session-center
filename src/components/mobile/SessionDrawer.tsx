/**
 * SessionDrawer — the phone's session list while a session is open (AASC-18),
 * in place of the desktop's session strip: a full-height sheet with the same
 * views (Rooms / Projects / Recent activity), the same frames in the same order
 * (useSessionStrip, shared with the strip), and room and project actions sized
 * for a finger.
 *
 *  - A row opens its session. Its ⋯ opens SessionActionsSheet (label, remark,
 *    fork, clone) for that session.
 *  - A room frame folds, and kills all its live sessions after a ConfirmSheet.
 *  - A project frame folds, and starts a new Claude or Codex session there.
 *  - Search and New session sit at the top: the drawer is where a phone user
 *    is when they look for, or start, a session.
 */
import { useCallback, useState, type CSSProperties } from 'react';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import { MoreActionsIcon, NewSessionIcon, SearchIcon, SkullIcon } from '@/components/ui/icons';
import { CLI_LAUNCHERS, type CliCommand } from '@/components/layout/cliLaunchers';
import StatusGlyph from '@/components/session/StatusGlyph';
import { LabelChip } from '@/components/session/LabelPicker';
import { FrameCollapseIcon } from '@/components/session/SessionFrameIcons';
import type { SessionStrip } from '@/hooks/useSessionStrip';
import type { StripItem } from '@/lib/sessionStrip';
import { launchBlocker } from '@/lib/launchSession';
import { launchInProjectGroup } from '@/lib/projectLaunch';
import type { ProjectGroup } from '@/lib/projectGroups';
import { killRoomSessions, liveRoomSessions } from '@/lib/roomKill';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { statusColor, statusLabel } from '@/lib/sessionStatusStyle';
import { useLabelStore } from '@/stores/labelStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore, type SessionSortMode } from '@/stores/uiStore';
import type { Session } from '@/types';
import QuickLaunchSheet from './QuickLaunchSheet';
import SessionActionsSheet from './SessionActionsSheet';
import styles from '@/styles/modules/SessionDrawer.module.css';

const VIEWS: ReadonlyArray<{ id: SessionSortMode; label: string }> = [
  { id: 'room', label: 'Rooms' },
  { id: 'project', label: 'Projects' },
  { id: 'activity', label: 'Recent' },
];

type DrawerItem = Exclude<StripItem, { type: 'session' }> | { type: 'loose'; sessions: Session[] };

/** Runs of loose cards (sessions in no frame) become one list each. */
function groupLooseSessions(items: readonly StripItem[]): DrawerItem[] {
  const out: DrawerItem[] = [];
  for (const item of items) {
    if (item.type !== 'session') {
      out.push(item);
      continue;
    }
    const last = out[out.length - 1];
    if (last?.type === 'loose') last.sessions.push(item.session);
    else out.push({ type: 'loose', sessions: [item.session] });
  }
  return out;
}

/** How many session names the kill-all confirm lists before "+N more". */
const KILL_NAME_CAP = 8;

interface SessionDrawerProps {
  open: boolean;
  onClose: () => void;
  strip: SessionStrip;
  currentSessionId: string;
  /** Sessions that finished a turn you have not looked at (the strip's ✓). */
  attentionIds: ReadonlySet<string>;
  onSelect: (sessionId: string) => void;
}

interface RowProps {
  session: Session;
  index: number;
  isCurrent: boolean;
  /** The RECENT frame's second listing: aria-current stays with the session's own row. */
  isRecentCopy?: boolean;
  completed: boolean;
  onSelect: (id: string) => void;
  onMore: (id: string) => void;
}

function SessionRow({ session, index, isCurrent, isRecentCopy, completed, onSelect, onMore }: RowProps) {
  const title = sessionDisplayTitle(session);
  const label = useLabelStore((s) => s.labels[session.sessionId]);
  const labelColor = useLabelStore((s) => s.labelColor);
  const status = statusLabel(session.status);
  const project = session.projectName && session.projectName !== title ? session.projectName : '';
  const needsYou = session.status === 'approval' || session.status === 'input';
  const name = [
    index > 0 ? `#${index}` : '',
    title,
    isCurrent ? 'open now' : '',
    completed ? 'Completed, not yet viewed' : status,
    project,
    label ? `Label ${label}` : '',
    session.remark ? `Remark: ${session.remark}` : '',
  ].filter(Boolean).join(', ');

  return (
    <li
      className={styles.row}
      data-current={isCurrent ? 'true' : undefined}
      data-needs-you={needsYou ? 'true' : undefined}
      style={{ '--status-color': statusColor(session.status) } as CSSProperties}
    >
      <button
        type="button"
        className={styles.rowMain}
        aria-current={isCurrent && !isRecentCopy ? 'true' : undefined}
        aria-label={name}
        data-session-id={session.sessionId}
        onClick={() => onSelect(session.sessionId)}
      >
        <span className={styles.rowGlyph} aria-hidden="true">
          {completed ? <span className={styles.completed}>✓</span> : <StatusGlyph status={session.status} />}
        </span>
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>
            {index > 0 && <span className={styles.rowIndex}>{index}</span>}
            {title}
          </span>
          <span className={styles.rowMeta}>
            {isCurrent && <span className={styles.rowOpen}>Open</span>}
            <span className={styles.rowStatus}>{completed ? 'Completed' : status}</span>
            {project && <span className={styles.rowProject}>{project}</span>}
            {label && <LabelChip name={label} color={labelColor(label)} small />}
          </span>
          {session.remark && <span className={styles.rowRemark}>{session.remark}</span>}
        </span>
      </button>
      <IconButton
        label="More actions"
        ariaLabel={`More for ${title}: label, remark, fork, clone`}
        tooltip={false}
        className={styles.rowMore}
        onClick={() => onMore(session.sessionId)}
      >
        <MoreActionsIcon />
      </IconButton>
    </li>
  );
}

function FrameToggle({
  name,
  count,
  collapsed,
  kind,
  onToggle,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  kind: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={styles.frameToggle}
      aria-expanded={!collapsed}
      aria-label={`${kind} ${name}, ${count} session${count === 1 ? '' : 's'}`}
      onClick={onToggle}
    >
      <span className={styles.frameChevron} aria-hidden="true"><FrameCollapseIcon collapsed={collapsed} /></span>
      <span className={styles.frameName}>{name}</span>
      <span className={styles.frameCount}>{count}</span>
    </button>
  );
}

function ProjectLaunchButtons({ group }: { group: ProjectGroup }) {
  const [pending, setPending] = useState<CliCommand | null>(null);
  if (!group.local) return null;
  const blocker = launchBlocker(group.launchPath);
  return (
    <>
      {CLI_LAUNCHERS.map(({ command, label, Icon }) => (
        <IconButton
          key={command}
          label={blocker ? `Can't start a session here: ${blocker}` : `New ${label} session in ${group.label}`}
          tooltip={false}
          className={`${styles.frameAction} ${styles.launchAction}`}
          disabled={blocker !== null || pending !== null}
          aria-busy={pending === command ? true : undefined}
          onClick={async () => {
            if (pending) return;
            setPending(command);
            try {
              await launchInProjectGroup(group, command);
            } finally {
              setPending(null);
            }
          }}
        >
          <Icon size={16} />
          <NewSessionIcon className={styles.launchPlus} />
        </IconButton>
      ))}
    </>
  );
}

export default function SessionDrawer({ open, onClose, strip, currentSessionId, attentionIds, onSelect }: SessionDrawerProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const mode = useUiStore((s) => s.sessionSortMode);
  const setMode = useUiStore((s) => s.setSessionSortMode);
  const selectedRoomIds = useUiStore((s) => s.selectedRoomIds);
  const clearRoomFilter = useUiStore((s) => s.clearRoomFilter);
  const collapsedProjects = useUiStore((s) => s.collapsedProjects);
  const toggleProjectCollapsed = useUiStore((s) => s.toggleProjectCollapsed);
  const recentCollapsed = useUiStore((s) => s.recentRoomCollapsed);
  const toggleRecentCollapsed = useUiStore((s) => s.toggleRecentRoomCollapsed);
  const openModal = useUiStore((s) => s.openModal);
  const toggleRoomCollapse = useRoomStore((s) => s.toggleCollapse);

  const [launchOpen, setLaunchOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  const [killTarget, setKillTarget] = useState<Room | null>(null);
  const [killing, setKilling] = useState(false);

  const closeLaunch = useCallback(() => setLaunchOpen(false), []);
  const closeActions = useCallback(() => setActionsFor(null), []);
  const cancelKill = useCallback(() => { if (!killing) setKillTarget(null); }, [killing]);

  const search = () => {
    onClose();
    openModal('global-search');
  };
  const newSession = () => {
    onClose();
    setLaunchOpen(true);
  };

  const killTargets = killTarget ? liveRoomSessions(killTarget, sessions) : [];
  const confirmKill = async () => {
    if (!killTarget || killing || killTargets.length === 0) return;
    setKilling(true);
    try {
      await killRoomSessions(killTarget.name, killTargets);
    } finally {
      setKilling(false);
      setKillTarget(null);
    }
  };

  const row = (s: Session, recentCopy = false) => (
    <SessionRow
      key={s.sessionId}
      session={s}
      index={strip.sessionIndexMap.get(s.sessionId) ?? 0}
      isCurrent={s.sessionId === currentSessionId}
      isRecentCopy={recentCopy}
      completed={s.sessionId !== currentSessionId && attentionIds.has(s.sessionId)}
      onSelect={onSelect}
      onMore={setActionsFor}
    />
  );

  const filterCount = selectedRoomIds.size;

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title="Sessions" fullHeight>
        <div className={styles.drawer} data-testid="session-drawer">
          <div className={styles.toolbar}>
            <div className={styles.views} role="group" aria-label="Group sessions by">
              {VIEWS.map((v) => (
                <Button key={v.id} pressed={mode === v.id} className={styles.view} onClick={() => setMode(v.id)}>
                  {v.label}
                </Button>
              ))}
            </div>
            <div className={styles.toolbarActions}>
              <IconButton label="Search all sessions" tooltip={false} onClick={search}>
                <SearchIcon />
              </IconButton>
              <IconButton label="New session" tooltip={false} onClick={newSession}>
                <NewSessionIcon />
              </IconButton>
            </div>
          </div>

          {filterCount > 0 && (
            <div className={styles.filterNote}>
              <span>Showing {filterCount === 1 ? '1 room' : `${filterCount} rooms`} only.</span>
              <Button size="sm" onClick={clearRoomFilter}>Show all</Button>
            </div>
          )}

          {strip.items.length === 0 ? (
            <p className={styles.emptyNote}>No sessions to show.</p>
          ) : (
            <div className={styles.frames}>
              {groupLooseSessions(strip.items).map((item) => {
                if (item.type === 'loose') {
                  return (
                    <ul key={`loose:${item.sessions[0].sessionId}`} className={`${styles.rows} ${styles.looseRows}`}>
                      {item.sessions.map((s) => row(s))}
                    </ul>
                  );
                }
                if (item.type === 'recent') {
                  return (
                    <section key="builtin:recent" className={`${styles.frame} ${styles.recentFrame}`}>
                      <div className={styles.frameHeader}>
                        <FrameToggle
                          kind="Recent"
                          name="Recent"
                          count={item.sessions.length}
                          collapsed={recentCollapsed}
                          onToggle={toggleRecentCollapsed}
                        />
                      </div>
                      {!recentCollapsed && <ul className={styles.rows}>{item.sessions.map((s) => row(s, true))}</ul>}
                    </section>
                  );
                }
                if (item.type === 'project') {
                  const { group } = item;
                  const collapsed = collapsedProjects.has(group.key);
                  return (
                    <section
                      key={group.key}
                      className={styles.frame}
                      style={{ '--room-color': item.color } as CSSProperties}
                    >
                      <div className={styles.frameHeader}>
                        <FrameToggle
                          kind="Project"
                          name={group.label}
                          count={group.sessions.length}
                          collapsed={collapsed}
                          onToggle={() => toggleProjectCollapsed(group.key)}
                        />
                        <ProjectLaunchButtons group={group} />
                      </div>
                      {!collapsed && <ul className={styles.rows}>{group.sessions.map((s) => row(s))}</ul>}
                    </section>
                  );
                }
                const { room } = item;
                const live = liveRoomSessions(room, sessions).length;
                return (
                  <section
                    key={room.id}
                    className={styles.frame}
                    style={{ '--room-color': item.color } as CSSProperties}
                  >
                    <div className={styles.frameHeader}>
                      <FrameToggle
                        kind="Room"
                        name={room.name}
                        count={item.sessions.length}
                        collapsed={room.collapsed}
                        onToggle={() => toggleRoomCollapse(room.id)}
                      />
                      {live > 0 && (
                        <IconButton
                          label={`Kill all ${live} session${live === 1 ? '' : 's'} in ${room.name}`}
                          tooltip={false}
                          tone="danger"
                          className={styles.frameAction}
                          onClick={() => setKillTarget(room)}
                        >
                          <SkullIcon />
                        </IconButton>
                      )}
                    </div>
                    {!room.collapsed && <ul className={styles.rows}>{item.sessions.map((s) => row(s))}</ul>}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </BottomSheet>

      <QuickLaunchSheet open={launchOpen} onClose={closeLaunch} />
      <SessionActionsSheet sessionId={actionsFor} onClose={closeActions} onOpened={onClose} />
      <ConfirmSheet
        open={killTarget !== null}
        title={killTarget ? `Kill all sessions in "${killTarget.name}"?` : 'Kill all sessions?'}
        danger
        busy={killing}
        confirmLabel={killTargets.length > 0 ? `Kill ${killTargets.length}` : 'Kill'}
        onCancel={cancelKill}
        onConfirm={() => void confirmKill()}
        message={
          killTargets.length === 0 ? (
            'This room has no live sessions to kill.'
          ) : (
            <>
              <p className={styles.confirmLead}>
                This ends {killTargets.length} live session{killTargets.length === 1 ? '' : 's'} (SIGTERM, then
                SIGKILL). Ended sessions are skipped.
              </p>
              <ul className={styles.confirmList}>
                {killTargets.slice(0, KILL_NAME_CAP).map((s) => (
                  <li key={s.sessionId}>{sessionDisplayTitle(s)}</li>
                ))}
                {killTargets.length > KILL_NAME_CAP && <li>+{killTargets.length - KILL_NAME_CAP} more</li>}
              </ul>
            </>
          )
        }
      />
    </>
  );
}
