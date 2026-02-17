import { describe, it, expect, beforeEach } from 'vitest';
import { useGroupStore } from './groupStore';
import { clearLocalStorage } from '../__tests__/setup';

describe('groupStore', () => {
  beforeEach(() => {
    clearLocalStorage();
    useGroupStore.setState({ groups: [] });
  });

  describe('createGroup', () => {
    it('creates a group and returns its id', () => {
      const id = useGroupStore.getState().createGroup('Review');
      expect(id).toMatch(/^group-/);
      const { groups } = useGroupStore.getState();
      expect(groups).toHaveLength(1);
      expect(groups[0].name).toBe('Review');
      expect(groups[0].sessionIds).toEqual([]);
      expect(groups[0].collapsed).toBe(false);
    });

    it('creates multiple groups', () => {
      useGroupStore.getState().createGroup('Group A');
      useGroupStore.getState().createGroup('Group B');
      expect(useGroupStore.getState().groups).toHaveLength(2);
    });

    it('persists to localStorage', () => {
      useGroupStore.getState().createGroup('Persistent');
      const stored = JSON.parse(localStorage.getItem('session-groups') ?? '[]');
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe('Persistent');
    });
  });

  describe('renameGroup', () => {
    it('renames a group', () => {
      const id = useGroupStore.getState().createGroup('Old Name');
      useGroupStore.getState().renameGroup(id, 'New Name');
      expect(useGroupStore.getState().groups[0].name).toBe('New Name');
    });

    it('does not affect other groups', () => {
      const id1 = useGroupStore.getState().createGroup('A');
      useGroupStore.getState().createGroup('B');
      useGroupStore.getState().renameGroup(id1, 'AA');
      expect(useGroupStore.getState().groups[1].name).toBe('B');
    });
  });

  describe('deleteGroup', () => {
    it('removes a group', () => {
      const id = useGroupStore.getState().createGroup('ToDelete');
      useGroupStore.getState().deleteGroup(id);
      expect(useGroupStore.getState().groups).toHaveLength(0);
    });

    it('persists deletion to localStorage', () => {
      const id = useGroupStore.getState().createGroup('ToDelete');
      useGroupStore.getState().deleteGroup(id);
      const stored = JSON.parse(localStorage.getItem('session-groups') ?? '[]');
      expect(stored).toHaveLength(0);
    });
  });

  describe('addSession / removeSession', () => {
    it('adds a session to a group', () => {
      const id = useGroupStore.getState().createGroup('G1');
      useGroupStore.getState().addSession(id, 's1');
      expect(useGroupStore.getState().groups[0].sessionIds).toEqual(['s1']);
    });

    it('does not add duplicate session ids', () => {
      const id = useGroupStore.getState().createGroup('G1');
      useGroupStore.getState().addSession(id, 's1');
      useGroupStore.getState().addSession(id, 's1');
      expect(useGroupStore.getState().groups[0].sessionIds).toEqual(['s1']);
    });

    it('removes a session from a group', () => {
      const id = useGroupStore.getState().createGroup('G1');
      useGroupStore.getState().addSession(id, 's1');
      useGroupStore.getState().addSession(id, 's2');
      useGroupStore.getState().removeSession(id, 's1');
      expect(useGroupStore.getState().groups[0].sessionIds).toEqual(['s2']);
    });
  });

  describe('toggleCollapse', () => {
    it('toggles collapsed state', () => {
      const id = useGroupStore.getState().createGroup('G1');
      expect(useGroupStore.getState().groups[0].collapsed).toBe(false);
      useGroupStore.getState().toggleCollapse(id);
      expect(useGroupStore.getState().groups[0].collapsed).toBe(true);
      useGroupStore.getState().toggleCollapse(id);
      expect(useGroupStore.getState().groups[0].collapsed).toBe(false);
    });
  });

  describe('loadFromStorage', () => {
    it('loads groups from localStorage', () => {
      const data = [
        { id: 'g1', name: 'Loaded', sessionIds: ['s1'], collapsed: false, createdAt: 1 },
      ];
      localStorage.setItem('session-groups', JSON.stringify(data));
      useGroupStore.getState().loadFromStorage();
      expect(useGroupStore.getState().groups).toHaveLength(1);
      expect(useGroupStore.getState().groups[0].name).toBe('Loaded');
    });

    it('returns empty array if localStorage is empty', () => {
      useGroupStore.getState().loadFromStorage();
      expect(useGroupStore.getState().groups).toEqual([]);
    });
  });
});
