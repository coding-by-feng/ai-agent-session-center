/**
 * useRoomSync — the room list follows the Mac (AASC-20): the workspace writer's
 * main window pushes its rooms, every other main window takes the Mac's. The
 * socket half (rooms_update, room_op, the read on connect) is in useWebSocket;
 * see lib/roomSync.ts.
 */
import { useEffect } from 'react';
import { startRoomSync } from '@/lib/roomSync';

export function useRoomSync(): void {
  useEffect(() => startRoomSync(), []);
}
