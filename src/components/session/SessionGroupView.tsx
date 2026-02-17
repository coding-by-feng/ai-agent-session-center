/**
 * SessionGroupView renders sessions organized into named groups.
 * Sessions can be dragged between groups. Groups can be collapsed, renamed, deleted.
 * Ungrouped sessions appear in a default "Ungrouped" section.
 */
import { useMemo, useState, useCallback, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  DragOverlay,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSessionStore } from '@/stores/sessionStore';
import { useGroupStore, type SessionGroup } from '@/stores/groupStore';
import SessionCard from './SessionCard';
import type { Session } from '@/types';
import groupStyles from '@/styles/modules/SessionGroup.module.css';
import cardStyles from '@/styles/modules/SessionCard.module.css';

// ---------------------------------------------------------------------------
// Sortable card wrapper (reused from SessionGrid)
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
      <SessionCard session={session} selected={selected} globalMuted={globalMuted} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Droppable group container
// ---------------------------------------------------------------------------

interface GroupDropZoneProps {
  groupId: string;
  children: React.ReactNode;
  isOver: boolean;
}

function GroupDropZone({ groupId, children, isOver }: GroupDropZoneProps) {
  const { setNodeRef } = useDroppable({ id: `group:${groupId}` });

  return (
    <div
      ref={setNodeRef}
      className={`${groupStyles.groupGrid} ${isOver ? groupStyles.dragOver : ''}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group Header with editable name
// ---------------------------------------------------------------------------

interface GroupHeaderProps {
  group: SessionGroup;
  sessionCount: number;
}

function GroupHeader({ group, sessionCount }: GroupHeaderProps) {
  const toggleCollapse = useGroupStore((s) => s.toggleCollapse);
  const renameGroup = useGroupStore((s) => s.renameGroup);
  const deleteGroup = useGroupStore((s) => s.deleteGroup);
  const [editing, setEditing] = useState(false);
  const nameRef = useRef<HTMLSpanElement>(null);

  function handleDoubleClick() {
    setEditing(true);
    requestAnimationFrame(() => {
      const el = nameRef.current;
      if (!el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
  }

  function handleBlur() {
    setEditing(false);
    const text = nameRef.current?.textContent?.trim();
    if (text && text !== group.name) {
      renameGroup(group.id, text);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
    if (e.key === 'Escape') {
      if (nameRef.current) nameRef.current.textContent = group.name;
      setEditing(false);
    }
  }

  return (
    <div className={groupStyles.header}>
      <span
        className={groupStyles.collapse}
        onClick={() => toggleCollapse(group.id)}
      >
        {group.collapsed ? '\u25B6' : '\u25BC'}
      </span>
      <span
        ref={nameRef}
        className={`${groupStyles.name} ${editing ? groupStyles.editing : ''}`}
        contentEditable={editing}
        suppressContentEditableWarning
        onDoubleClick={handleDoubleClick}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
      >
        {group.name}
      </span>
      <span className={groupStyles.count}>{sessionCount}</span>
      <button
        className={groupStyles.deleteBtn}
        onClick={() => deleteGroup(group.id)}
        title="Delete group"
      >
        x
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "Add Group" input
// ---------------------------------------------------------------------------

function AddGroupInput() {
  const createGroup = useGroupStore((s) => s.createGroup);
  const [name, setName] = useState('');

  function handleAdd() {
    const trimmed = name.trim();
    if (!trimmed) return;
    createGroup(trimmed);
    setName('');
  }

  return (
    <div style={{ display: 'flex', gap: '8px', padding: '8px 24px' }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
        placeholder="New group name..."
        style={{
          flex: 1,
          background: 'var(--bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '4px',
          color: 'var(--text-primary)',
          fontFamily: 'var(--font-mono)',
          fontSize: '11px',
          padding: '6px 10px',
          outline: 'none',
        }}
      />
      <button
        onClick={handleAdd}
        style={{
          padding: '6px 12px',
          background: 'rgba(0, 229, 255, 0.1)',
          border: '1px solid var(--accent-cyan)',
          borderRadius: '4px',
          color: 'var(--accent-cyan)',
          fontFamily: 'var(--font-mono)',
          fontSize: '10px',
          fontWeight: 700,
          letterSpacing: '1px',
          cursor: 'pointer',
        }}
      >
        + GROUP
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface SessionGroupViewProps {
  globalMuted?: boolean;
}

export default function SessionGroupView({ globalMuted = false }: SessionGroupViewProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const groups = useGroupStore((s) => s.groups);
  const addSession = useGroupStore((s) => s.addSession);
  const moveSession = useGroupStore((s) => s.moveSession);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [overGroupId, setOverGroupId] = useState<string | null>(null);

  // Collect all grouped session IDs
  const groupedIds = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) {
      for (const id of g.sessionIds) set.add(id);
    }
    return set;
  }, [groups]);

  // Ungrouped sessions
  const ungrouped = useMemo(() => {
    const list: Session[] = [];
    for (const sess of sessions.values()) {
      if (sess.archived) continue;
      if (!groupedIds.has(sess.sessionId)) list.push(sess);
    }
    return list.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }, [sessions, groupedIds]);

  // Session lookup for each group
  const groupSessions = useMemo(() => {
    const map = new Map<string, Session[]>();
    for (const g of groups) {
      const list: Session[] = [];
      for (const id of g.sessionIds) {
        const sess = sessions.get(id);
        if (sess && !sess.archived) list.push(sess);
      }
      map.set(g.id, list);
    }
    return map;
  }, [groups, sessions]);

  // Find which group a session belongs to
  const sessionGroupMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const g of groups) {
      for (const id of g.sessionIds) {
        map.set(id, g.id);
      }
    }
    return map;
  }, [groups]);

  // Sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveDragId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { over } = event;
    if (!over) {
      setOverGroupId(null);
      return;
    }
    const overId = String(over.id);
    if (overId.startsWith('group:')) {
      setOverGroupId(overId.replace('group:', ''));
    } else {
      // Hovering over a card — find its group
      const cardGroup = sessionGroupMap.get(overId);
      setOverGroupId(cardGroup ?? 'ungrouped');
    }
  }, [sessionGroupMap]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active } = event;
      const sessionId = String(active.id);
      const targetGroup = overGroupId;

      setActiveDragId(null);
      setOverGroupId(null);

      if (!targetGroup) return;

      const fromGroup = sessionGroupMap.get(sessionId);

      if (targetGroup === 'ungrouped') {
        // Remove from current group
        if (fromGroup) {
          const removeSession = useGroupStore.getState().removeSession;
          removeSession(fromGroup, sessionId);
        }
        return;
      }

      if (fromGroup === targetGroup) return;

      if (fromGroup) {
        moveSession(sessionId, fromGroup, targetGroup);
      } else {
        addSession(targetGroup, sessionId);
      }
    },
    [overGroupId, sessionGroupMap, moveSession, addSession],
  );

  const draggedSession = activeDragId ? sessions.get(activeDragId) : null;

  // All session IDs for SortableContext
  const allIds = useMemo(() => {
    const ids: string[] = [];
    for (const g of groups) {
      ids.push(...g.sessionIds);
    }
    for (const s of ungrouped) {
      ids.push(s.sessionId);
    }
    return ids;
  }, [groups, ungrouped]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <AddGroupInput />

      <SortableContext items={allIds} strategy={rectSortingStrategy}>
        <div className={groupStyles.container}>
          {/* Named groups */}
          {groups.map((group) => {
            const groupSessionList = groupSessions.get(group.id) ?? [];
            return (
              <div key={group.id} className={groupStyles.group}>
                <GroupHeader group={group} sessionCount={groupSessionList.length} />
                {!group.collapsed && (
                  <GroupDropZone
                    groupId={group.id}
                    isOver={overGroupId === group.id}
                  >
                    {groupSessionList.map((session) => (
                      <SortableCard
                        key={session.sessionId}
                        session={session}
                        selected={selectedSessionId === session.sessionId}
                        globalMuted={globalMuted}
                      />
                    ))}
                  </GroupDropZone>
                )}
              </div>
            );
          })}

          {/* Ungrouped sessions */}
          {ungrouped.length > 0 && (
            <div className={groupStyles.group}>
              <div className={groupStyles.header}>
                <span className={groupStyles.name}>Ungrouped</span>
                <span className={groupStyles.count}>{ungrouped.length}</span>
              </div>
              <GroupDropZone groupId="ungrouped" isOver={overGroupId === 'ungrouped'}>
                {ungrouped.map((session) => (
                  <SortableCard
                    key={session.sessionId}
                    session={session}
                    selected={selectedSessionId === session.sessionId}
                    globalMuted={globalMuted}
                  />
                ))}
              </GroupDropZone>
            </div>
          )}
        </div>
      </SortableContext>

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
