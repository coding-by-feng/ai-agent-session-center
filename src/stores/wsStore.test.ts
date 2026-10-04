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

  // Sessions not shared with a remote device are left out of its snapshot; the
  // server says how many, so that device can say "not shared" instead of "none".
  describe('hiddenCount', () => {
    it('starts at 0 and takes the snapshot\'s count', () => {
      useWsStore.setState({ hiddenCount: 0 });
      useWsStore.getState().setHiddenCount(3);
      expect(useWsStore.getState().hiddenCount).toBe(3);
    });
  });

  // Until the first snapshot lands the session map is empty because nothing
  // has loaded yet, not because there are no sessions. The LIVE page waits
  // for this before it says "No agent sessions yet".
  describe('snapshotReceived', () => {
    it('starts false and is set once a snapshot arrives', () => {
      useWsStore.setState({ snapshotReceived: false });
      expect(useWsStore.getState().snapshotReceived).toBe(false);
      useWsStore.getState().setSnapshotReceived(true);
      expect(useWsStore.getState().snapshotReceived).toBe(true);
    });
  });
});
