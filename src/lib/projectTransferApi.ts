/**
 * Copy / Move a project to another computer over HTTP (`/api/project-transfer`, this computer only;
 * Nov 27 2026, docs/plans/project-transfer.md). The bytes travel through Electron main
 * (`window.electronAPI.remotes.projectTransferStart`); these calls plan a transfer on the source,
 * and answer an incoming one's Allow on the target.
 */
import type {
  IncomingTransferRequest,
  MovedProject,
  TransferOptions,
  TransferPlanInfo,
} from '@/types/projectTransfer';

/** A refusal with the server's sentence and, when it gave one, its code. */
export class TransferRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

const BASE = '/api/project-transfer';
const enc = encodeURIComponent;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, init);
  } catch {
    throw new TransferRequestError('Could not reach AASC on this computer.');
  }
  let result: { success?: boolean; data?: T; error?: string; code?: string };
  try {
    result = await res.json();
  } catch {
    throw new TransferRequestError(
      'Moving projects is available only on the computer that runs AASC.',
    );
  }
  if (!res.ok || !result.success)
    throw new TransferRequestError(
      result.error || 'Could not complete the transfer request.',
      result.code,
    );
  return result.data as T;
}

const post = (body?: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body ?? {}),
});

export const projectTransferApi = {
  /** Scan the folder into a plan. It hashes every file, so it can take several seconds. */
  plan: (root: string, options: TransferOptions) =>
    request<TransferPlanInfo>('/plan', post({ root, options })),
  discardPlan: (planId: string) => request<null>(`/plan/${enc(planId)}`, { method: 'DELETE' }),
  /** Pending Allow requests other computers sent here. */
  requests: () => request<IncomingTransferRequest[]>('/requests'),
  allow: (id: string) => request<null>(`/requests/${enc(id)}/allow`, post()),
  decline: (id: string) => request<null>(`/requests/${enc(id)}/decline`, post()),
  /** The markers a Move left on this computer. */
  moved: () => request<MovedProject[]>('/moved'),
};
