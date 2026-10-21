/**
 * SessionViewMenu — the session panel's one "View" menu (AASC-11).
 *
 * It replaces six bare icons that sat in a row in the header: the room filter,
 * the Rooms / Projects / Recent view switch, the status-colour legend, the card
 * density toggle, the dock toggle and maximize. They are settings, not verbs,
 * and most people could not tell them apart without hovering each one. Now they
 * are labelled items in one place, on the shared `Menu`, which also keeps the
 * list inside the window and works from the keyboard.
 *
 * The status-colour legend is reference, not a choice: it is the menu's footer,
 * outside role="menu".
 */
import { useMemo } from 'react';
import Menu, { type MenuSection } from '@/components/ui/Menu';
import {
  ActivityViewIcon,
  CompactModeIcon,
  DetailedModeIcon,
  DockLeftIcon,
  DockTopIcon,
  MaximizeIcon,
  ProjectViewIcon,
  RoomViewIcon,
  ViewIcon,
} from '@/components/ui/icons';
import { STATUS_COLORS, STATUS_LEGEND } from '@/lib/sessionStatusStyle';
import type { SessionSortMode } from '@/stores/uiStore';
import type { Room } from '@/stores/roomStore';
import styles from '@/styles/modules/SessionViewMenu.module.css';

const VIEW_LABELS: Record<SessionSortMode, string> = {
  room: 'Rooms',
  project: 'Projects',
  activity: 'Recent activity',
};

const VIEW_HINTS: Record<SessionSortMode, string> = {
  room: 'Group sessions into their rooms',
  project: 'Group sessions by project directory, with buttons to start a new one',
  activity: 'One flat list, most recently active first',
};

const VIEW_ICONS: Record<SessionSortMode, () => React.ReactElement> = {
  room: () => <RoomViewIcon />,
  project: () => <ProjectViewIcon />,
  activity: () => <ActivityViewIcon />,
};

export interface SessionViewMenuProps {
  mode: SessionSortMode;
  onModeChange: (mode: SessionSortMode) => void;
  /** Rooms that hold a live session — the ones a filter can show. */
  rooms: readonly Pick<Room, 'id' | 'name'>[];
  selectedRoomIds: ReadonlySet<string>;
  onToggleRoom: (roomId: string) => void;
  onClearRooms: () => void;
  compact: boolean;
  onToggleCompact: () => void;
  navPosition: 'top' | 'left';
  onToggleNavPosition: () => void;
  maximized: boolean;
  onToggleMaximized: () => void;
  className?: string;
}

export default function SessionViewMenu({
  mode,
  onModeChange,
  rooms,
  selectedRoomIds,
  onToggleRoom,
  onClearRooms,
  compact,
  onToggleCompact,
  navPosition,
  onToggleNavPosition,
  maximized,
  onToggleMaximized,
  className,
}: SessionViewMenuProps) {
  const filtering = selectedRoomIds.size > 0;

  const sections = useMemo<MenuSection[]>(() => {
    const viewModes: SessionSortMode[] = ['room', 'project', 'activity'];
    return [
      {
        id: 'group',
        title: 'Group sessions',
        items: viewModes.map((m) => ({
          kind: 'radio' as const,
          id: `group-${m}`,
          label: VIEW_LABELS[m],
          hint: VIEW_HINTS[m],
          icon: VIEW_ICONS[m](),
          checked: m === mode,
          onSelect: () => { if (m !== mode) onModeChange(m); },
        })),
      },
      {
        id: 'rooms',
        title: 'Rooms shown',
        items: rooms.length === 0 ? [] : [
          {
            kind: 'checkbox' as const,
            id: 'rooms-all',
            label: 'All rooms',
            checked: !filtering,
            onSelect: () => { if (filtering) onClearRooms(); },
          },
          ...rooms.map((r) => ({
            kind: 'checkbox' as const,
            id: `room-${r.id}`,
            label: r.name,
            checked: selectedRoomIds.has(r.id),
            onSelect: () => onToggleRoom(r.id),
          })),
        ],
      },
      {
        id: 'cards',
        title: 'Cards',
        items: [
          { kind: 'radio' as const, id: 'cards-detailed', label: 'Detailed', icon: <DetailedModeIcon />, checked: !compact, onSelect: () => { if (compact) onToggleCompact(); } },
          { kind: 'radio' as const, id: 'cards-compact', label: 'Compact', icon: <CompactModeIcon />, checked: compact, onSelect: () => { if (!compact) onToggleCompact(); } },
        ],
      },
      {
        id: 'panel',
        title: 'Session list',
        items: [
          { kind: 'radio' as const, id: 'dock-top', label: 'On top', icon: <DockTopIcon />, checked: navPosition === 'top', onSelect: () => { if (navPosition !== 'top') onToggleNavPosition(); } },
          { kind: 'radio' as const, id: 'dock-left', label: 'On the left', icon: <DockLeftIcon />, checked: navPosition === 'left', onSelect: () => { if (navPosition !== 'left') onToggleNavPosition(); } },
          {
            kind: 'checkbox' as const,
            id: 'maximize',
            label: 'Hidden (maximize)',
            hint: maximized ? 'Bring the session list back (Esc)' : 'Hide the session list for more space',
            icon: <MaximizeIcon />,
            checked: maximized,
            onSelect: onToggleMaximized,
          },
        ],
      },
    ];
  }, [mode, onModeChange, rooms, filtering, selectedRoomIds, onToggleRoom, onClearRooms, compact, onToggleCompact, navPosition, onToggleNavPosition, maximized, onToggleMaximized]);

  const state = [
    VIEW_LABELS[mode],
    filtering && `${selectedRoomIds.size} room${selectedRoomIds.size === 1 ? '' : 's'} shown`,
    maximized && 'list hidden',
  ].filter(Boolean).join(', ');

  // The left rail's last row (View · + · folder · Pinned room … minimize · «) is
  // 213px wide, and the sliders icon was the 6px too many: there the trigger is
  // its word and chevron. The top bar has room for it.
  const inRail = navPosition === 'left' && !maximized;

  return (
    <Menu
      label="View"
      triggerLabel={`View: ${state}`}
      triggerText="View"
      triggerIcon={inRail ? undefined : <ViewIcon />}
      triggerDescription="Grouping, rooms shown, card size and where the session list sits"
      active={mode !== 'room' || filtering || maximized}
      sections={sections}
      footer={<StatusLegend />}
      className={className}
    />
  );
}

function StatusLegend() {
  return (
    <div role="group" aria-label="Status colours" className={styles.legend}>
      <div className={styles.legendTitle} aria-hidden="true">Status colours</div>
      <ul className={styles.legendList}>
        {STATUS_LEGEND.map(({ status, label }) => (
          <li key={status} className={styles.legendRow}>
            <span className={styles.swatch} style={{ background: STATUS_COLORS[status] ?? 'var(--text-dim)' }} aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
