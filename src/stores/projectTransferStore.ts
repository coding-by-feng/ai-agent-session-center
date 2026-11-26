/**
 * projectTransferStore — the Allow requests other computers sent this one (Nov 27 2026,
 * docs/plans/project-transfer.md): the full list from each `project_transfer_requests` WS
 * message, and from `GET /api/project-transfer/requests` when the prompt mounts.
 */
import { create } from 'zustand';
import type { IncomingTransferRequest } from '@/types/projectTransfer';

interface ProjectTransferState {
  requests: IncomingTransferRequest[];
  setRequests: (requests: IncomingTransferRequest[]) => void;
  /** Drop one the person answered here, before the server's next list arrives. */
  removeRequest: (id: string) => void;
}

export const useProjectTransferStore = create<ProjectTransferState>((set) => ({
  requests: [],
  setRequests: (requests) => set({ requests: Array.isArray(requests) ? requests : [] }),
  removeRequest: (id) => set((s) => ({ requests: s.requests.filter((r) => r.id !== id) })),
}));
