/**
 * useCollapsedRooms — which room groups this phone shows folded on Sessions
 * (AASC-55). Per device, kept in localStorage under its own key: folding a room
 * here never folds it on the Mac (`Room.collapsed` is the desktop strip's).
 */
import { useCallback, useMemo, useState } from 'react';
import type { Room } from '@/types';
import {
  COLLAPSED_ROOMS_KEY, parseCollapsedRooms, pruneCollapsedRooms, toggleRoomCollapsed,
} from '@/lib/chat/roomsListModel';

function readCollapsed(): ReadonlySet<string> {
  try {
    return parseCollapsedRooms(localStorage.getItem(COLLAPSED_ROOMS_KEY));
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_ROOMS_KEY, JSON.stringify([...collapsed]));
  } catch {
    /* the folds last until reload */
  }
}

export function useCollapsedRooms(rooms: readonly Room[]): {
  collapsed: ReadonlySet<string>;
  toggle: (roomId: string) => void;
} {
  const [stored, setStored] = useState<ReadonlySet<string>>(readCollapsed);
  // Only rooms this phone has are shown folded. Storage keeps the others: a room
  // can drop out of the phone's list while none of its sessions is shared, and
  // come back folded as it was (reading caps the list, so it cannot grow forever).
  const collapsed = useMemo(() => pruneCollapsedRooms(stored, rooms), [stored, rooms]);
  const toggle = useCallback((roomId: string) => {
    setStored((prev) => {
      const next = toggleRoomCollapsed(prev, roomId);
      writeCollapsed(next);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}
