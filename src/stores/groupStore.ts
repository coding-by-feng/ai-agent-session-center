import { create } from 'zustand';

export interface SessionGroup {
  id: string;
  name: string;
  sessionIds: string[];
  collapsed: boolean;
  createdAt: number;
}

const STORAGE_KEY = 'session-groups';

function loadFromLocalStorage(): SessionGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SessionGroup[];
  } catch {
    // Ignore parse errors
  }
  return [];
}

function saveToLocalStorage(groups: SessionGroup[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Ignore quota errors
  }
}

interface GroupState {
  groups: SessionGroup[];

  createGroup: (name: string) => string;
  renameGroup: (groupId: string, name: string) => void;
  deleteGroup: (groupId: string) => void;
  addSession: (groupId: string, sessionId: string) => void;
  removeSession: (groupId: string, sessionId: string) => void;
  moveSession: (sessionId: string, fromGroupId: string, toGroupId: string) => void;
  toggleCollapse: (groupId: string) => void;
  loadFromStorage: () => void;
}

export const useGroupStore = create<GroupState>((set, get) => ({
  groups: loadFromLocalStorage(),

  createGroup: (name) => {
    const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const group: SessionGroup = {
      id,
      name,
      sessionIds: [],
      collapsed: false,
      createdAt: Date.now(),
    };
    set((state) => {
      const groups = [...state.groups, group];
      saveToLocalStorage(groups);
      return { groups };
    });
    return id;
  },

  renameGroup: (groupId, name) =>
    set((state) => {
      const groups = state.groups.map((g) => (g.id === groupId ? { ...g, name } : g));
      saveToLocalStorage(groups);
      return { groups };
    }),

  deleteGroup: (groupId) =>
    set((state) => {
      const groups = state.groups.filter((g) => g.id !== groupId);
      saveToLocalStorage(groups);
      return { groups };
    }),

  addSession: (groupId, sessionId) =>
    set((state) => {
      const groups = state.groups.map((g) => {
        if (g.id !== groupId) return g;
        if (g.sessionIds.includes(sessionId)) return g;
        return { ...g, sessionIds: [...g.sessionIds, sessionId] };
      });
      saveToLocalStorage(groups);
      return { groups };
    }),

  removeSession: (groupId, sessionId) =>
    set((state) => {
      const groups = state.groups.map((g) => {
        if (g.id !== groupId) return g;
        return { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) };
      });
      saveToLocalStorage(groups);
      return { groups };
    }),

  moveSession: (sessionId, fromGroupId, toGroupId) =>
    set((state) => {
      if (fromGroupId === toGroupId) return state;
      const groups = state.groups.map((g) => {
        if (g.id === fromGroupId) {
          return { ...g, sessionIds: g.sessionIds.filter((id) => id !== sessionId) };
        }
        if (g.id === toGroupId) {
          if (g.sessionIds.includes(sessionId)) return g;
          return { ...g, sessionIds: [...g.sessionIds, sessionId] };
        }
        return g;
      });
      saveToLocalStorage(groups);
      return { groups };
    }),

  toggleCollapse: (groupId) =>
    set((state) => {
      const groups = state.groups.map((g) =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g,
      );
      saveToLocalStorage(groups);
      return { groups };
    }),

  loadFromStorage: () => {
    const groups = loadFromLocalStorage();
    set({ groups });
    return groups;
  },
}));
