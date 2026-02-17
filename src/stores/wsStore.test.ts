import { describe, it, expect, beforeEach } from 'vitest';
import { useWsStore } from './wsStore';

describe('wsStore', () => {
  beforeEach(() => {
    useWsStore.setState({
      connected: false,
      reconnecting: false,
      lastSeq: 0,
    });
  });

  describe('initial state', () => {
    it('starts disconnected', () => {
      expect(useWsStore.getState().connected).toBe(false);
      expect(useWsStore.getState().reconnecting).toBe(false);
      expect(useWsStore.getState().lastSeq).toBe(0);
    });
  });

  describe('setConnected', () => {
    it('sets connected to true', () => {
      useWsStore.getState().setConnected(true);
      expect(useWsStore.getState().connected).toBe(true);
    });

    it('sets connected to false', () => {
      useWsStore.getState().setConnected(true);
      useWsStore.getState().setConnected(false);
      expect(useWsStore.getState().connected).toBe(false);
    });
  });

  describe('setReconnecting', () => {
    it('sets reconnecting flag', () => {
      useWsStore.getState().setReconnecting(true);
      expect(useWsStore.getState().reconnecting).toBe(true);
    });
  });

  describe('setLastSeq', () => {
    it('updates lastSeq', () => {
      useWsStore.getState().setLastSeq(42);
      expect(useWsStore.getState().lastSeq).toBe(42);
    });

    it('tracks increasing sequence numbers', () => {
      useWsStore.getState().setLastSeq(10);
      useWsStore.getState().setLastSeq(20);
      expect(useWsStore.getState().lastSeq).toBe(20);
    });
  });
});
