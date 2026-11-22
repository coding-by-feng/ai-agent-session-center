/**
 * callMemoryClient — the browser side of call memory (server/voice/callMemory.ts, Nov 22 2026).
 * GET /api/voice/memory lists what calls proposed and what was kept; POST /api/voice/memory/:id decides one.
 */

export type CallMemoryKind = 'preference' | 'correction' | 'pattern';
export type CallMemoryStatus = 'proposed' | 'kept' | 'skipped' | 'retired';

export interface CallMemoryItem {
  id: string;
  kind: CallMemoryKind;
  meant: string;
  heard: string;
  /** `global` or `project:<folder>`. */
  scope: string;
  status: CallMemoryStatus;
  createdAt: number;
  seenCount: number;
}

export interface CallMemoryList {
  items: CallMemoryItem[];
  /** Folders this device may scope an item to. */
  projects: string[];
}

export type CallMemoryDecision =
  | { action: 'keep'; scope?: string; meant?: string }
  | { action: 'skip' }
  | { action: 'retire' };

export const CALL_MEMORY_URL = '/api/voice/memory';

/** When the phone banner looks again after Sessions opens: the suggestions come up to a minute after hang-up. */
export const CALL_MEMORY_RECHECK_MS = [20_000, 70_000] as const;

export async function fetchCallMemory(): Promise<CallMemoryList | null> {
  const res = await fetch(CALL_MEMORY_URL);
  if (!res.ok) return null;
  const body = (await res.json()) as { data?: CallMemoryList };
  return body.data ?? null;
}

export async function decideCallMemory(id: string, decision: CallMemoryDecision): Promise<CallMemoryItem> {
  const res = await fetch(`${CALL_MEMORY_URL}/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decision),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: { item?: CallMemoryItem }; error?: string };
  if (!res.ok || !body.data?.item) throw new Error(body.error ?? 'Could not save that');
  return body.data.item;
}

/** "agent-manager" for `project:/…/agent-manager`, "Everywhere" for global. */
export function scopeLabel(scope: string): string {
  if (!scope.startsWith('project:')) return 'Everywhere';
  const path = scope.slice('project:'.length).replace(/\/+$/, '');
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

export const KIND_LABELS: Record<CallMemoryKind, string> = {
  preference: 'Preference',
  correction: 'Correction',
  pattern: 'Habit',
};
