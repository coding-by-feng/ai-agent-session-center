import { describe, it, expect, beforeEach } from 'vitest';
import { useRoomStore } from './roomStore';
import { clearLocalStorage } from '../__tests__/setup';

describe('roomStore', () => {
  beforeEach(() => {
    clearLocalStorage();
    useRoomStore.setState({ rooms: [] });
  });

  describe('createRoom', () => {
    it('creates a room and returns its id', () => {
      const id = useRoomStore.getState().createRoom('Review');
      expect(id).toMatch(/^room-/);
      const { rooms } = useRoomStore.getState();
      expect(rooms).toHaveLength(1);
      expect(rooms[0].name).toBe('Review');
      expect(rooms[0].sessionIds).toEqual([]);
      expect(rooms[0].collapsed).toBe(false);
    });

    it('creates multiple rooms', () => {
      useRoomStore.getState().createRoom('Room A');
      useRoomStore.getState().createRoom('Room B');
      expect(useRoomStore.getState().rooms).toHaveLength(2);
    });

    it('persists to localStorage', () => {
      useRoomStore.getState().createRoom('Persistent');
      const stored = JSON.parse(localStorage.getItem('session-rooms') ?? '[]');
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe('Persistent');
    });
  });

  describe('renameRoom', () => {
    it('renames a room', () => {
      const id = useRoomStore.getState().createRoom('Old Name');
      useRoomStore.getState().renameRoom(id, 'New Name');
      expect(useRoomStore.getState().rooms[0].name).toBe('New Name');
    });

    it('does not affect other rooms', () => {
      const id1 = useRoomStore.getState().createRoom('A');
      useRoomStore.getState().createRoom('B');
      useRoomStore.getState().renameRoom(id1, 'AA');
      expect(useRoomStore.getState().rooms[1].name).toBe('B');
    });
  });

  describe('deleteRoom', () => {
    it('removes a room', () => {
      const id = useRoomStore.getState().createRoom('ToDelete');
      useRoomStore.getState().deleteRoom(id);
      expect(useRoomStore.getState().rooms).toHaveLength(0);
    });

    it('persists deletion to localStorage', () => {
      const id = useRoomStore.getState().createRoom('ToDelete');
      useRoomStore.getState().deleteRoom(id);
      const stored = JSON.parse(localStorage.getItem('session-rooms') ?? '[]');
      expect(stored).toHaveLength(0);
    });
  });

  describe('addSession / removeSession', () => {
    it('adds a session to a room', () => {
      const id = useRoomStore.getState().createRoom('R1');
      useRoomStore.getState().addSession(id, 's1');
      expect(useRoomStore.getState().rooms[0].sessionIds).toEqual(['s1']);
    });

    it('does not add duplicate session ids', () => {
      const id = useRoomStore.getState().createRoom('R1');
      useRoomStore.getState().addSession(id, 's1');
      useRoomStore.getState().addSession(id, 's1');
      expect(useRoomStore.getState().rooms[0].sessionIds).toEqual(['s1']);
    });

    it('removes a session from a room', () => {
      const id = useRoomStore.getState().createRoom('R1');
      useRoomStore.getState().addSession(id, 's1');
      useRoomStore.getState().addSession(id, 's2');
      useRoomStore.getState().removeSession(id, 's1');
      expect(useRoomStore.getState().rooms[0].sessionIds).toEqual(['s2']);
    });
  });

  describe('toggleCollapse', () => {
    it('toggles collapsed state', () => {
      const id = useRoomStore.getState().createRoom('R1');
      expect(useRoomStore.getState().rooms[0].collapsed).toBe(false);
      useRoomStore.getState().toggleCollapse(id);
      expect(useRoomStore.getState().rooms[0].collapsed).toBe(true);
      useRoomStore.getState().toggleCollapse(id);
      expect(useRoomStore.getState().rooms[0].collapsed).toBe(false);
    });
  });

  describe('loadFromStorage', () => {
    it('loads rooms from localStorage', () => {
      const data = [
        { id: 'r1', name: 'Loaded', sessionIds: ['s1'], collapsed: false, createdAt: 1 },
      ];
      localStorage.setItem('session-rooms', JSON.stringify(data));
      useRoomStore.getState().loadFromStorage();
      expect(useRoomStore.getState().rooms).toHaveLength(1);
      expect(useRoomStore.getState().rooms[0].name).toBe('Loaded');
    });

    it('returns empty array if localStorage is empty', () => {
      useRoomStore.getState().loadFromStorage();
      expect(useRoomStore.getState().rooms).toEqual([]);
    });
  });
});
