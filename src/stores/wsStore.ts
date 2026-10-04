import { create } from 'zustand';
import type { WsClient } from '@/lib/wsClient';

interface WsState {
  connected: boolean;
  reconnecting: boolean;
  lastSeq: number;
  client: WsClient | null;
  /**
   * A `snapshot` has arrived since the app started, so the session map is the
   * real list. Before it, an empty map only means "not loaded yet" — the LIVE
   * page waits for this before it says "No agent sessions yet". Set by the
   * snapshot handler in useWebSocket and never cleared: after a disconnect the
   * last list is still the best one there is.
   */
  snapshotReceived: boolean;
  /**
   * Sessions the server left out of the last snapshot because they are not
   * shared with this device (server/sessionVisibility.ts; 0 on this machine).
   * Lets a remote device say "not shared" instead of "no sessions".
   */
  hiddenCount: number;

  setConnected: (connected: boolean) => void;
  setReconnecting: (reconnecting: boolean) => void;
  setLastSeq: (seq: number) => void;
  setClient: (client: WsClient | null) => void;
  setSnapshotReceived: (received: boolean) => void;
  setHiddenCount: (count: number) => void;
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  reconnecting: false,
  lastSeq: 0,
  client: null,
  snapshotReceived: false,
  hiddenCount: 0,

  setConnected: (connected) => set({ connected }),
  setReconnecting: (reconnecting) => set({ reconnecting }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setClient: (client) => set({ client }),
  setSnapshotReceived: (received) => set({ snapshotReceived: received }),
  setHiddenCount: (count) => set({ hiddenCount: count }),
}));
