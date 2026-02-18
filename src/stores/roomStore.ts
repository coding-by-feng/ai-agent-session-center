import { create } from 'zustand';

export interface Room {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed: boolean;
  createdAt: number;
  /** Mapped room index: 0=NW, 1=NE, 2=SW, 3=SE. Undefined = corridor. */
  roomIndex?: number;
}

const STORAGE_KEY = 'session-rooms';

function loadFromLocalStorage(): Room[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Room[];
  } catch {
    // Ignore parse errors
  }
  return [];
}

function saveToLocalStorage(rooms: Room[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
  } catch {
    // Ignore quota errors
  }
}

interface RoomState {
  rooms: Room[];

  createRoom: (name: string) => string;
  renameRoom: (roomId: string, name: string) => void;
  deleteRoom: (roomId: string) => void;
  addSession: (roomId: string, sessionId: string) => void;
  removeSession: (roomId: string, sessionId: string) => void;
  moveSession: (sessionId: string, fromRoomId: string, toRoomId: string) => void;
  toggleCollapse: (roomId: string) => void;
  setRoomIndex: (roomId: string, roomIndex: number | undefined) => void;
  getRoomForSession: (sessionId: string) => Room | undefined;
  loadFromStorage: () => void;
}

export const useRoomStore = create<RoomState>((set, get) => ({
  rooms: loadFromLocalStorage(),

  createRoom: (name) => {
    const id = `room-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Auto-assign next available room index (no limit)
    const currentRooms = get().rooms;
    const usedRooms = new Set(currentRooms.map((r) => r.roomIndex).filter((ri) => ri != null));
    let roomIndex = 0;
    while (usedRooms.has(roomIndex)) roomIndex++;
    const room: Room = {
      id,
      name,
      sessionIds: [],
      collapsed: false,
      createdAt: Date.now(),
      roomIndex,
    };
    set((state) => {
      const rooms = [...state.rooms, room];
      saveToLocalStorage(rooms);
      return { rooms };
    });
    return id;
  },

  renameRoom: (roomId, name) =>
    set((state) => {
      const rooms = state.rooms.map((r) => (r.id === roomId ? { ...r, name } : r));
      saveToLocalStorage(rooms);
      return { rooms };
    }),

  deleteRoom: (roomId) =>
    set((state) => {
      const rooms = state.rooms.filter((r) => r.id !== roomId);
      saveToLocalStorage(rooms);
      return { rooms };
    }),

  addSession: (roomId, sessionId) =>
    set((state) => {
      const rooms = state.rooms.map((r) => {
        if (r.id !== roomId) return r;
        if (r.sessionIds.includes(sessionId)) return r;
        return { ...r, sessionIds: [...r.sessionIds, sessionId] };
      });
      saveToLocalStorage(rooms);
      return { rooms };
    }),

  removeSession: (roomId, sessionId) =>
    set((state) => {
      const rooms = state.rooms.map((r) => {
        if (r.id !== roomId) return r;
        return { ...r, sessionIds: r.sessionIds.filter((id) => id !== sessionId) };
      });
      saveToLocalStorage(rooms);
      return { rooms };
    }),

  moveSession: (sessionId, fromRoomId, toRoomId) =>
    set((state) => {
      if (fromRoomId === toRoomId) return state;
      const rooms = state.rooms.map((r) => {
        if (r.id === fromRoomId) {
          return { ...r, sessionIds: r.sessionIds.filter((id) => id !== sessionId) };
        }
        if (r.id === toRoomId) {
          if (r.sessionIds.includes(sessionId)) return r;
          return { ...r, sessionIds: [...r.sessionIds, sessionId] };
        }
        return r;
      });
      saveToLocalStorage(rooms);
      return { rooms };
    }),

  toggleCollapse: (roomId) =>
    set((state) => {
      const rooms = state.rooms.map((r) =>
        r.id === roomId ? { ...r, collapsed: !r.collapsed } : r,
      );
      saveToLocalStorage(rooms);
      return { rooms };
    }),

  setRoomIndex: (roomId, roomIndex) =>
    set((state) => {
      const rooms = state.rooms.map((r) =>
        r.id === roomId ? { ...r, roomIndex } : r,
      );
      saveToLocalStorage(rooms);
      return { rooms };
    }),

  getRoomForSession: (sessionId) => {
    return get().rooms.find((r) => r.sessionIds.includes(sessionId));
  },

  loadFromStorage: () => {
    const rooms = loadFromLocalStorage();
    set({ rooms });
    return rooms;
  },
}));
