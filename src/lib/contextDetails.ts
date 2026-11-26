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
import { breakdownSchema } from '@/lib/chat/chatApi';
import type { ContextBreakdown } from '@/types/chat';
import { formatTokens } from '@/lib/formatTokens';
import { resolveContextDisplay, resolveRuntimeDisplay, type ContextDisplay } from '@/lib/sessionRuntime';

/** One line of the TOKENS table (Nov 27 2026): the last reply's or the whole session's. */
export interface TokenRow {
  label: 'Last reply' | 'Session';
  input: string;
  /** Under the input: "cached 259k · new 3.7k". */
  detail?: string;
  output?: string;
}

export interface ContextDetailsView {
  model: string;
  /** "xhigh"; absent when unknown. */
  effort?: string;
  /** "165 steps" — API replies made in this session. */
  steps?: string;
  context?: {
    /** "263k / 1M (26.3%)" */
    text: string;
    /** "737k free"; absent when the size is unknown or nothing is free. */
    free?: string;
    pct: number;
    level: ContextDisplay['level'];
    /** The % was worked out here, not reported by the CLI. */
    estimated: boolean;
  };
  /** The last reply, then the session (once its totals arrive). */
  tokens: TokenRow[];
  /** "last reply 98.6% · session 96.8%" */
  cacheHit?: string;
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

function replyRow(parts: SessionContextParts | undefined): TokenRow | null {
  const input = parts ? inputOf(parts) : undefined;
  if (!parts || input === undefined) return null;
  const fresh = input - (parts.cacheRead ?? 0);
  return {
    label: 'Last reply',
    input: formatTokens(input),
    ...(parts.cacheRead !== undefined ? { detail: `cached ${formatTokens(parts.cacheRead)} · new ${formatTokens(fresh)}` } : {}),
    ...(parts.output !== undefined ? { output: formatTokens(parts.output) } : {}),
  };
}

function sessionRow(totals: SessionUsageTotals | undefined): TokenRow | null {
  if (!totals) return null;
  return {
    label: 'Session',
    input: formatTokens(inputOf(totals) ?? 0),
    detail: `cached ${formatTokens(totals.cacheRead)}`,
    output: formatTokens(totals.output),
  };
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
        ...(ctx.tokens !== undefined && ctx.size && ctx.size > ctx.tokens
          ? { free: `${formatTokens(ctx.size - ctx.tokens)} free` }
          : {}),
        pct: Math.min(100, exactPct),
        level: ctx.level,
        estimated: raw?.estimated === true,
      }
    : undefined;

  const tokens = [replyRow(parts), sessionRow(totals)].filter((r): r is TokenRow => r !== null);
  const replyHit = parts ? hitRate(parts, inputOf(parts)) : undefined;
  const sessionHit = totals ? hitRate(totals, inputOf(totals)) : undefined;
  const hits = [replyHit && `last reply ${replyHit}`, sessionHit && `session ${sessionHit}`].filter(Boolean);

  return {
    model: runtime.model,
    ...(runtime.effort ? { effort: runtime.effort } : {}),
    ...(totals ? { steps: `${totals.steps.toLocaleString('en-US')} ${totals.steps === 1 ? 'step' : 'steps'}` } : {}),
    ...(context ? { context } : {}),
    tokens,
    ...(hits.length ? { cacheHit: hits.join(' · ') } : {}),
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

/**
 * `GET /api/sessions/:id/context-breakdown` (Nov 27 2026): what fills the window, as the phone's
 * Usage sheet reads it, through `authFetch` (a browser dashboard's password). null for a session
 * the server can't measure (Codex). Throws on a failed or unreadable answer.
 */
export async function fetchWindowBreakdown(sessionId: string, signal?: AbortSignal): Promise<ContextBreakdown | null> {
  const res = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/context-breakdown`, { signal });
  if (!res.ok) throw new Error(`context-breakdown answered ${res.status}`);
  const body = (await res.json()) as { success?: unknown; data?: unknown };
  if (body?.success !== true) throw new Error('context-breakdown failed');
  if (body.data === null) return null;
  const parsed = breakdownSchema.safeParse(body.data);
  if (!parsed.success) throw new Error('context-breakdown sent an unreadable answer');
  return parsed.data as ContextBreakdown;
}

const VIEWPORT_MARGIN = 8;
const GAP = 6;

export interface CardPlacement { top: number; left: number; maxHeight: number }

/**
 * Below the chip when the whole card fits there, else above; when it fits neither way, on the
 * larger side with its height capped to that space (the card scrolls inside). The natural
 * height is `scrollHeight` + the border, read through any cap already set.
 */
export function placeCard(
  anchor: { top: number; bottom: number; left: number },
  card: { width: number; naturalHeight: number },
  viewport: { width: number; height: number },
): CardPlacement {
  const left = Math.max(VIEWPORT_MARGIN, Math.min(viewport.width - card.width - VIEWPORT_MARGIN, anchor.left));
  const below = anchor.bottom + GAP;
  const roomBelow = viewport.height - VIEWPORT_MARGIN - below;
  const roomAbove = anchor.top - GAP - VIEWPORT_MARGIN;
  const h = card.naturalHeight;
  if (h <= roomBelow) return { top: below, left, maxHeight: roomBelow };
  if (h <= roomAbove) return { top: anchor.top - GAP - h, left, maxHeight: roomAbove };
  return roomBelow >= roomAbove
    ? { top: below, left, maxHeight: Math.max(0, roomBelow) }
    : { top: VIEWPORT_MARGIN, left, maxHeight: Math.max(0, roomAbove) };
}
