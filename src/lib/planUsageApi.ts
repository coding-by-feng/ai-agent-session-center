/**
 * The client side of the plan-usage chip's sync button. The server re-reads the CLI's
 * usage files and answers with when it looked, how old the newest reading is and
 * whether the numbers moved. It does not send the numbers: those arrive on the
 * session update, behind the session's visibility gate.
 */
import { readJson } from '@/lib/requestJson';
import type { PlanCli } from '@/types/session';

export interface PlanUsageSyncReply {
  cli: PlanCli;
  checkedAt: number;
  /** When the newest reading was taken; null when nothing has ever been read. */
  asOf: number | null;
  changed: boolean;
}

const FAILED = 'Could not sync plan usage';

function isReply(value: unknown): value is PlanUsageSyncReply {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.cli === 'claude' || v.cli === 'codex')
    && typeof v.checkedAt === 'number'
    && typeof v.changed === 'boolean'
    && (v.asOf === null || typeof v.asOf === 'number')
  );
}

export async function syncPlanUsage(cli: PlanCli, signal?: AbortSignal): Promise<PlanUsageSyncReply> {
  const res = await fetch('/api/plan-usage/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cli }),
    signal,
  });
  const body = await readJson<{ success?: boolean; data?: unknown; error?: string }>(res, FAILED);
  if (!body.success || !isReply(body.data)) throw new Error(body.error || FAILED);
  return body.data;
}
