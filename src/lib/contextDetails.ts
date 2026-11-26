/**
 * The header's Context details card (Nov 25 2026): what `ContextDetailsPopover` shows,
 * worked out from the session's live context (`session.runtime.context`, the last reply)
 * and the server's totals (`GET /api/sessions/:id/context-usage`).
 *
 * Anything the CLI did not report is left out (`undefined`), never shown as 0.
 */
import { z } from 'zod';
import type { Session } from '@/types';
import type { SessionContextParts, SessionUsageDetails, SessionUsageTotals } from '@/types/session';
import { authFetch } from '@/hooks/useAuth';
import { formatTokens } from '@/lib/formatTokens';
import { resolveContextDisplay, resolveRuntimeDisplay, type ContextDisplay } from '@/lib/sessionRuntime';

export interface MetricCell {
  label: string;
  value: string;
  /** The smaller text after the value, e.g. "(cached 259k / new 3.7k)". */
  detail?: string;
}

export interface ContextDetailsView {
  model: string;
  /** "165 steps" — API replies made in this session. */
  steps?: string;
  context?: {
    /** "263k / 1M (26.3%)" */
    text: string;
    pct: number;
    level: ContextDisplay['level'];
    /** The % was worked out here, not reported by the CLI. */
    estimated: boolean;
  };
  /** Pairs, left then right, in reading order. */
  cells: MetricCell[];
  /** "$14.08" */
  cost?: string;
  shortId: string;
  /** "115×35" */
  terminal?: string;
}

const pctText = (n: number): string => `${n.toFixed(1).replace(/\.0$/, '')}%`;

/** Input of a reply or a session: everything sent, whether new, written to or read from the cache. */
function inputOf(p: { input?: number; cacheWrite?: number; cacheRead?: number }): number | undefined {
  if (p.input === undefined && p.cacheWrite === undefined && p.cacheRead === undefined) return undefined;
  return (p.input ?? 0) + (p.cacheWrite ?? 0) + (p.cacheRead ?? 0);
}

function hitRate(p: { cacheRead?: number }, total: number | undefined): string | undefined {
  if (p.cacheRead === undefined || !total) return undefined;
  return pctText((p.cacheRead / total) * 100);
}

function cell(label: string, value: string | undefined, detail?: string): MetricCell | null {
  return value === undefined ? null : { label, value, ...(detail ? { detail } : {}) };
}

function turnCells(parts: SessionContextParts | undefined): Array<MetricCell | null> {
  if (!parts) return [null, null];
  const input = inputOf(parts);
  const fresh = input !== undefined ? input - (parts.cacheRead ?? 0) : undefined;
  return [
    cell(
      'Reply input',
      input !== undefined ? formatTokens(input) : undefined,
      parts.cacheRead !== undefined && fresh !== undefined
        ? `(cached ${formatTokens(parts.cacheRead)} / new ${formatTokens(fresh)})`
        : undefined,
    ),
    cell('Reply output', parts.output !== undefined ? formatTokens(parts.output) : undefined),
  ];
}

function sessionCells(totals: SessionUsageTotals | undefined): Array<MetricCell | null> {
  if (!totals) return [null, null];
  const input = inputOf(totals) ?? 0;
  return [
    cell('Session input', formatTokens(input), `(cached ${formatTokens(totals.cacheRead)})`),
    cell('Session output', formatTokens(totals.output)),
  ];
}

export function contextDetailsView(session: Session, usage: SessionUsageDetails | null): ContextDetailsView | null {
  const runtime = resolveRuntimeDisplay(session);
  if (!runtime) return null;
  const ctx = resolveContextDisplay(session);
  const raw = session.runtime?.context;
  const parts = raw?.parts;
  const totals = usage?.totals;

  // One decimal when the token counts allow it (26.3%), else the CLI's whole number.
  const exactPct = ctx?.tokens !== undefined && ctx.size ? (ctx.tokens / ctx.size) * 100 : ctx?.pct;
  const context = ctx && exactPct !== undefined
    ? {
        text: ctx.tokens !== undefined && ctx.size
          ? `${formatTokens(ctx.tokens)} / ${formatTokens(ctx.size)} (${pctText(exactPct)})`
          : pctText(exactPct),
        pct: Math.min(100, exactPct),
        level: ctx.level,
        estimated: raw?.estimated === true,
      }
    : undefined;

  const turnInput = parts ? inputOf(parts) : undefined;
  const cells = [
    cell('Reply cache hit', parts ? hitRate(parts, turnInput) : undefined),
    cell('Session cache hit', totals ? hitRate(totals, inputOf(totals)) : undefined),
    ...turnCells(parts),
    ...sessionCells(totals),
  ].filter((c): c is MetricCell => c !== null);

  return {
    model: runtime.model,
    ...(totals ? { steps: `${totals.steps.toLocaleString('en-US')} ${totals.steps === 1 ? 'step' : 'steps'}` } : {}),
    ...(context ? { context } : {}),
    cells,
    ...(usage?.costUsd !== undefined ? { cost: `$${usage.costUsd.toFixed(2)}` } : {}),
    shortId: session.sessionId.slice(0, 8),
    ...(usage?.terminal ? { terminal: `${usage.terminal.cols}×${usage.terminal.rows}` } : {}),
  };
}

const count = z.number().int().nonnegative();
const usageSchema = z.object({
  totals: z.object({ steps: count, input: count, cacheWrite: count, cacheRead: count, output: count }).optional(),
  costUsd: z.number().nonnegative().optional(),
  terminal: z.object({ cols: count, rows: count }).optional(),
});

/** `GET /api/sessions/:id/context-usage`. Throws on a failed or unreadable answer. */
export async function fetchSessionUsage(sessionId: string, signal?: AbortSignal): Promise<SessionUsageDetails> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-usage`, { signal });
  if (!res.ok) throw new Error(`context-usage answered ${res.status}`);
  const body = (await res.json()) as { success?: unknown; data?: unknown };
  const parsed = usageSchema.safeParse(body?.data);
  if (body?.success !== true || !parsed.success) throw new Error('context-usage sent an unreadable answer');
  return parsed.data;
}
