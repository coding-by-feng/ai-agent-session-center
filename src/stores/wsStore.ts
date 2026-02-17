import { create } from 'zustand';
import type { WsClient } from '@/lib/wsClient';

interface WsState {
  connected: boolean;
  reconnecting: boolean;
  lastSeq: number;
  client: WsClient | null;

  setConnected: (connected: boolean) => void;
  setReconnecting: (reconnecting: boolean) => void;
  setLastSeq: (seq: number) => void;
  setClient: (client: WsClient | null) => void;
}

export const useWsStore = create<WsState>((set) => ({
  connected: false,
  reconnecting: false,
  lastSeq: 0,
  client: null,

  setConnected: (connected) => set({ connected }),
  setReconnecting: (reconnecting) => set({ reconnecting }),
  setLastSeq: (seq) => set({ lastSeq: seq }),
  setClient: (client) => set({ client }),
}));
