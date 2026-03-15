import { create } from 'zustand';
import type { AgendaTask, AgendaFilter } from '@/types';

interface AgendaState {
  tasks: Map<string, AgendaTask>;
  loading: boolean;
  filter: AgendaFilter;

  fetchTasks: () => Promise<void>;
  createTask: (data: Omit<AgendaTask, 'id' | 'completed' | 'completedAt' | 'createdAt' | 'updatedAt'>) => Promise<void>;
  updateTask: (id: string, data: Partial<Pick<AgendaTask, 'title' | 'description' | 'priority' | 'tags' | 'dueDate'>>) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  setFilter: (partial: Partial<AgendaFilter>) => void;
}

const DEFAULT_FILTER: AgendaFilter = {
  search: '',
  priority: 'all',
  tag: 'all',
  showCompleted: false,
  sortBy: 'priority',
};

export const useAgendaStore = create<AgendaState>((set, get) => ({
  tasks: new Map(),
  loading: false,
  filter: { ...DEFAULT_FILTER },

  fetchTasks: async () => {
    set({ loading: true });
    try {
      const res = await fetch('/api/agenda');
      const json = await res.json();
      if (json.ok && Array.isArray(json.data)) {
        const next = new Map<string, AgendaTask>();
        for (const task of json.data) {
          next.set(task.id, task);
        }
        set({ tasks: next, loading: false });
      } else {
        set({ loading: false });
      }
    } catch {
      set({ loading: false });
    }
  },

  createTask: async (data) => {
    // Optimistic: generate a temp ID
    const tempId = `temp-${Date.now()}`;
    const now = new Date().toISOString();
    const optimistic: AgendaTask = {
      id: tempId,
      title: data.title,
      description: data.description,
      priority: data.priority,
      tags: data.tags,
      dueDate: data.dueDate,
      completed: false,
      createdAt: now,
      updatedAt: now,
    };

    set((state) => {
      const next = new Map(state.tasks);
      next.set(tempId, optimistic);
      return { tasks: next };
    });

    try {
      const res = await fetch('/api/agenda', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (json.ok && json.data) {
        // Replace temp with real
        set((state) => {
          const next = new Map(state.tasks);
          next.delete(tempId);
          next.set(json.data.id, json.data);
          return { tasks: next };
        });
      } else {
        // Revert
        set((state) => {
          const next = new Map(state.tasks);
          next.delete(tempId);
          return { tasks: next };
        });
      }
    } catch {
      // Revert
      set((state) => {
        const next = new Map(state.tasks);
        next.delete(tempId);
        return { tasks: next };
      });
    }
  },

  updateTask: async (id, data) => {
    const prev = get().tasks.get(id);
    if (!prev) return;

    // Optimistic
    const updated: AgendaTask = {
      ...prev,
      ...data,
      updatedAt: new Date().toISOString(),
    };
    set((state) => {
      const next = new Map(state.tasks);
      next.set(id, updated);
      return { tasks: next };
    });

    try {
      const res = await fetch(`/api/agenda/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const json = await res.json();
      if (json.ok && json.data) {
        set((state) => {
          const next = new Map(state.tasks);
          next.set(id, json.data);
          return { tasks: next };
        });
      } else {
        // Revert
        set((state) => {
          const next = new Map(state.tasks);
          next.set(id, prev);
          return { tasks: next };
        });
      }
    } catch {
      // Revert
      set((state) => {
        const next = new Map(state.tasks);
        next.set(id, prev);
        return { tasks: next };
      });
    }
  },

  deleteTask: async (id) => {
    const prev = get().tasks.get(id);
    if (!prev) return;

    // Optimistic
    set((state) => {
      const next = new Map(state.tasks);
      next.delete(id);
      return { tasks: next };
    });

    try {
      const res = await fetch(`/api/agenda/${id}`, { method: 'DELETE' });
      const json = await res.json();
      if (!json.ok) {
        // Revert
        set((state) => {
          const next = new Map(state.tasks);
          next.set(id, prev);
          return { tasks: next };
        });
      }
    } catch {
      // Revert
      set((state) => {
        const next = new Map(state.tasks);
        next.set(id, prev);
        return { tasks: next };
      });
    }
  },

  toggleTask: async (id) => {
    const prev = get().tasks.get(id);
    if (!prev) return;

    const now = new Date().toISOString();
    const toggled: AgendaTask = {
      ...prev,
      completed: !prev.completed,
      completedAt: !prev.completed ? now : undefined,
      updatedAt: now,
    };

    // Optimistic
    set((state) => {
      const next = new Map(state.tasks);
      next.set(id, toggled);
      return { tasks: next };
    });

    try {
      const res = await fetch(`/api/agenda/${id}/toggle`, { method: 'PATCH' });
      const json = await res.json();
      if (json.ok && json.data) {
        set((state) => {
          const next = new Map(state.tasks);
          next.set(id, json.data);
          return { tasks: next };
        });
      } else {
        // Revert
        set((state) => {
          const next = new Map(state.tasks);
          next.set(id, prev);
          return { tasks: next };
        });
      }
    } catch {
      // Revert
      set((state) => {
        const next = new Map(state.tasks);
        next.set(id, prev);
        return { tasks: next };
      });
    }
  },

  setFilter: (partial) =>
    set((state) => ({
      filter: { ...state.filter, ...partial },
    })),
}));
