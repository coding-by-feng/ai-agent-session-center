/**
 * useWorkspaceAutoSave — triggers a debounced auto-save of the workspace
 * snapshot whenever sessions or rooms change.
 */
import { useEffect, useRef } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { scheduleAutoSave, cancelAutoSave } from '@/lib/workspaceSnapshot';

export function useWorkspaceAutoSave(): void {
  const sessions = useSessionStore((s) => s.sessions);
  const rooms = useRoomStore((s) => s.rooms);

  // Keep stable references so the debounced callback reads fresh state
  const sessionsRef = useRef(sessions);
  const roomsRef = useRef(rooms);
  sessionsRef.current = sessions;
  roomsRef.current = rooms;

  useEffect(() => {
    // Skip initial render — only auto-save after actual changes
    scheduleAutoSave(() => sessionsRef.current, () => roomsRef.current);
  }, [sessions, rooms]);

  // Cleanup on unmount
  useEffect(() => cancelAutoSave, []);
}
