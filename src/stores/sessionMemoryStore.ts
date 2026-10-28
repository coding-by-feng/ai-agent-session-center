/**
 * sessionMemoryStore — the latest memory reading of this Mac's sessions (Oct 28 2026,
 * server/sessionMemory.ts `GET /api/session-memory`). Filled by `useSessionMemoryPoll` (mounted
 * once, by the header's MemoryChip); read by the chip and the LIVE board's cards. `null` until the
 * first reading, and for good on a device the Mac answers 404 (only this Mac may read it).
 */
import { create } from 'zustand';

export interface SessionMemorySample {
  at: number;
  totalBytes: number;
  appBytes: number;
  bySession: Record<string, number>;
  asleep: number;
}

interface SessionMemoryState {
  sample: SessionMemorySample | null;
  setSample: (sample: SessionMemorySample | null) => void;
}

export const useSessionMemoryStore = create<SessionMemoryState>((set) => ({
  sample: null,
  setSample: (sample) => set({ sample }),
}));
