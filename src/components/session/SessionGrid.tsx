/**
 * SessionGrid renders a sortable grid of SessionCards using dnd-kit.
 * Active sessions sort to the front; pinned sessions stay at the top.
 * Ported from the grid logic in public/js/sessionCard.js.
 */
import { useMemo, useCallback, useState } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSessionStore } from '@/stores/sessionStore';
import SessionCard from './SessionCard';
import type { Session } from '@/types';
import styles from '@/styles/modules/SessionCard.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PINNED_KEY = 'pinned-sessions';
const ACTIVE_STATUSES = new Set(['working', 'prompting', 'approval', 'input']);

function loadPinnedSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PINNED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Sort helpers
// ---------------------------------------------------------------------------

function sessionSortKey(session: Session, pinnedSet: Set<string>): number {
  if (pinnedSet.has(session.sessionId)) return 0;
  if (ACTIVE_STATUSES.has(session.status)) return 1;
  if (session.status === 'idle' || session.status === 'waiting') return 2;
  if (session.status === 'ended') return 4;
  return 3;
}

function sortSessions(sessions: Session[], pinnedSet: Set<string>): Session[] {
  return [...sessions].sort((a, b) => {
    const ka = sessionSortKey(a, pinnedSet);
    const kb = sessionSortKey(b, pinnedSet);
    if (ka !== kb) return ka - kb;
    return b.lastActivityAt - a.lastActivityAt;
  });
}

// ---------------------------------------------------------------------------
// SortableCard wrapper
// ---------------------------------------------------------------------------

interface SortableCardProps {
  session: Session;
  selected: boolean;
  globalMuted: boolean;
}

function SortableCard({ session, selected, globalMuted }: SortableCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: session.sessionId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    zIndex: isDragging ? 100 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <SessionCard
        session={session}
        selected={selected}
        globalMuted={globalMuted}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionGrid
// ---------------------------------------------------------------------------

export interface SessionGridProps {
  /** If provided, filter to these session IDs only */
  filterIds?: string[];
  globalMuted?: boolean;
}

export default function SessionGrid({ filterIds, globalMuted = false }: SessionGridProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);

  // Manual order override (user-dragged)
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const pinnedSet = useMemo(() => loadPinnedSet(), []);

  // Build sorted session list
  const sortedSessions = useMemo(() => {
    let list: Session[] = [];
    for (const sess of sessions.values()) {
      if (filterIds && !filterIds.includes(sess.sessionId)) continue;
      // Skip archived unless explicitly included
      if (sess.archived && !filterIds) continue;
      list.push(sess);
    }

    // If user has manually reordered, use that order for the subset
    if (orderOverride) {
      const sessionMap = new Map(list.map((s) => [s.sessionId, s]));
      const ordered: Session[] = [];
      for (const id of orderOverride) {
        const sess = sessionMap.get(id);
        if (sess) {
          ordered.push(sess);
          sessionMap.delete(id);
        }
      }
      // Append any new sessions not in the override
      for (const sess of sessionMap.values()) {
        ordered.push(sess);
      }
      return ordered;
    }

    return sortSessions(list, pinnedSet);
  }, [sessions, filterIds, pinnedSet, orderOverride]);

  const sessionIds = useMemo(
    () => sortedSessions.map((s) => s.sessionId),
    [sortedSessions],
  );

  // Sensors — require 8px movement to start a drag (prevents accidental drags on click)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDragId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const oldIndex = sessionIds.indexOf(String(active.id));
      const newIndex = sessionIds.indexOf(String(over.id));
      if (oldIndex === -1 || newIndex === -1) return;

      const newOrder = arrayMove(sessionIds, oldIndex, newIndex);
      setOrderOverride(newOrder);
    },
    [sessionIds],
  );

  const draggedSession = activeDragId
    ? sessions.get(activeDragId)
    : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={sessionIds} strategy={rectSortingStrategy}>
        <div className={styles.grid}>
          {sortedSessions.map((session) => (
            <SortableCard
              key={session.sessionId}
              session={session}
              selected={selectedSessionId === session.sessionId}
              globalMuted={globalMuted}
            />
          ))}
        </div>
      </SortableContext>

      {/* Drag overlay for visual feedback */}
      <DragOverlay>
        {draggedSession ? (
          <div style={{ opacity: 0.8, transform: 'scale(0.95)' }}>
            <SessionCard
              session={draggedSession}
              selected={false}
              globalMuted={globalMuted}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
