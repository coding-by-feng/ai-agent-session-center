/**
 * usageModel.ts — the phone's usage chip and Usage sheet (Oct 20 2026): how full this
 * session's context window is, and how much of the account's plan limits are used, for
 * Claude Code and Codex. Pure: `now` is passed in.
 *
 * The plan figures are the ACCOUNT's (`session.planUsage`: every live session of one CLI
 * carries the freshest report), never "this session's"; `describePlanUsage` from the
 * desktop chip decides what is shown (an ended window is dropped, a report over ten
 * minutes old is marked, severity is judged on the number printed).
 */
import type { Session } from '@/types';
import type { ContextBreakdown, ContextKind } from '@/types/chat';
import { detectCli } from '@/lib/cliDetect';
import { describePlanUsage, formatAge, type PlanUsageView } from '@/lib/planUsage';
import { resolveContextDisplay, type ContextDisplay } from '@/lib/sessionRuntime';

export interface UsageContext {
  pct: number;
  /** "59%" */
  pctText: string;
  level: ContextDisplay['level'];
  /** "118k of 200k tokens", or null when the CLI gave only the %. */
  tokensText: string | null;
}

/**
 * What the Context window card shows when tapped (Oct 21 2026): free space, the last
 * reply's tokens by kind (as the CLI reported them) and how old the reading is. What fills
 * the window by type is not in what the CLI reports: the Mac measures it from the
 * transcript on request (`describeContextBreakdown`, Oct 22 2026).
 */
export interface UsageContextDetails {
  /** "753k free", or null without the window's size and tokens. */
  freeText: string | null;
  rows: Array<{ label: string; value: string }>;
  /** "Reported 3m ago", or null without a time. */
  reportedText: string | null;
}

export interface UsageChip {
  context: UsageContext | null;
  /** The plan's busiest running window, as the chip prints it: "5h 42%". */
  planText: string | null;
  /** That window is at or over 85%, or the CLI said a limit was hit: drawn with ▲. */
  planHigh: boolean;
}

export interface UsageView {
  context: UsageContext | null;
  /** Null when there is nothing beyond the % to show (the card then does not open). */
  contextDetails: UsageContextDetails | null;
  /** The account's plan limits; null for a session of no CLI the Mac reads limits for. */
  plan: PlanUsageView | null;
  /** Null when nothing is known yet: the row stays as it was. */
  chip: UsageChip | null;
  /** One sentence for a screen reader. */
  ariaLabel: string;
}

/** 950 · 9.5k · 118k · 1.2M */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

function contextOf(session: Session): UsageContext | null {
  const ctx = resolveContextDisplay(session);
  if (!ctx) return null;
  const pct = Math.round(ctx.pct);
  const tokensText = ctx.tokens !== undefined && ctx.size
    ? `${formatTokens(ctx.tokens)} of ${formatTokens(ctx.size)} tokens`
    : null;
  return { pct, pctText: `${pct}%`, level: ctx.level, tokensText };
}

const PART_LABELS = [
  ['cacheRead', 'Read from cache'],
  ['cacheWrite', 'Newly cached'],
  ['input', 'New input'],
  ['output', 'Last reply’s output'],
] as const;

function contextDetailsOf(session: Session, now: number): UsageContextDetails | null {
  const ctx = session.runtime?.context;
  if (!ctx) return null;
  const freeText = ctx.size && ctx.tokens !== undefined ? `${formatTokens(Math.max(0, ctx.size - ctx.tokens))} free` : null;
  const rows = PART_LABELS.flatMap(([key, label]) => {
    const n = ctx.parts?.[key];
    return n === undefined ? [] : [{ label, value: formatTokens(n) }];
  });
  if (!freeText && rows.length === 0) return null;
  const at = session.runtime?.contextAt;
  const age = at ? formatAge(at, now) : '';
  return { freeText, rows, reportedText: age ? `Reported ${age}` : null };
}

export function describeUsage(session: Session, now: number): UsageView {
  const cli = detectCli(session);
  const context = contextOf(session);
  const plan = cli === 'claude' || cli === 'codex' ? describePlanUsage(cli, session.planUsage, now) : null;
  const headline = plan?.state === 'ready' ? plan.headline : null;

  const chip: UsageChip | null = context || headline
    ? { context, planText: headline ? `${headline.label} ${headline.percentText}` : null, planHigh: !!headline && plan?.severity === 'high' }
    : null;

  const spoken: string[] = [];
  if (context) spoken.push(`context ${context.pctText} used${context.tokensText ? `, ${context.tokensText}` : ''}`);
  const parts = [`Usage: ${spoken.length ? spoken.join('') : 'context not reported yet'}.`];
  if (plan) parts.push(`${plan.ariaLabel}.`);
  return { context, contextDetails: contextDetailsOf(session, now), plan, chip, ariaLabel: parts.join(' ').replace(/\.\./g, '.') };
}

/** A kind's name on the card. */
export const CONTEXT_KIND_LABELS: Readonly<Record<ContextKind, string>> = {
  system: 'System prompt & setup',
  tools: 'Tool definitions',
  fixed: 'System prompt & tools',
  memory: 'Memory (CLAUDE.md, rules)',
  skills: 'Skills',
  summary: 'Compaction summary',
  prompts: 'Your prompts',
  replies: 'Claude’s replies',
  toolCalls: 'Tool calls',
  read: 'File reads',
  bash: 'Bash output',
  search: 'Search results',
  edits: 'Edits',
  subagents: 'Subagent reports',
  web: 'Web results',
  mcp: 'MCP results',
  otherTools: 'Other tool results',
  reminders: 'Reminders & hooks',
};

/** Kinds under this share of the window are folded into one "Other" row. */
const MIN_ROW_PCT = 0.5;

/** One line of what a kind holds: "Bash · npm test", ×3, 9.1k. */
export interface ContextEntryRow {
  key: string;
  label: string;
  /** "×3" for entries merged by name, else null. */
  countText: string | null;
  tokensText: string;
}

export interface ContextKindRow {
  key: string;
  label: string;
  tokensText: string;
  /** Share of the whole window (its size when known), 0–100. */
  pct: number;
  pctText: string;
  /** What it opens to (Oct 28 2026): its largest entries, or for Other the kinds it folds. */
  entries: ContextEntryRow[];
  /** "41 more" with its tokens, or null. */
  rest: { label: string; tokensText: string } | null;
  /** Said instead of entries for what the transcript can't split. */
  note: string | null;
}

/** What a kind with no entries says when opened. Free and the rest say nothing (not a button). */
const KIND_NOTES: Partial<Record<ContextKind, string>> = {
  system: 'Claude Code’s system prompt and setup, sent with every request. The transcript doesn’t record its parts.',
  fixed: 'Claude Code’s system prompt and tool definitions, sent with every request. This transcript doesn’t record how they split.',
  tools: 'The tools Claude can call, described with every request.',
};

export interface ContextBreakdownView {
  rows: ContextKindRow[];
  items: Array<{ key: string; label: string; tokensText: string }>;
  /** "Measured from 85 requests since the last compaction, 2m ago." */
  note: string;
}

const pctText = (pct: number): string => (pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`);

/**
 * The window by type, largest first, each as a share of the whole window (`size`, the
 * window's capacity, when known; else what is in it), then free space; and the largest items.
 */
export function describeContextBreakdown(b: ContextBreakdown, size: number | undefined, now: number): ContextBreakdownView {
  const whole = size && size >= b.tokens ? size : b.tokens || 1;
  const share = (tokens: number) => (tokens / whole) * 100;
  const rows: ContextKindRow[] = [];
  let other = 0;
  let otherKinds = 0;
  const folded: ContextEntryRow[] = [];
  for (const k of b.kinds) {
    if (share(k.tokens) < MIN_ROW_PCT) {
      other += k.tokens;
      otherKinds += 1;
      folded.push({ key: k.kind, label: CONTEXT_KIND_LABELS[k.kind], countText: null, tokensText: formatTokens(k.tokens) });
      continue;
    }
    const entries = (k.items ?? []).map((item, i) => ({
      key: `${i}`,
      label: item.label,
      countText: item.count && item.count > 1 ? `×${item.count}` : null,
      tokensText: formatTokens(item.tokens),
    }));
    rows.push({
      key: k.kind,
      label: CONTEXT_KIND_LABELS[k.kind],
      tokensText: formatTokens(k.tokens),
      pct: share(k.tokens),
      pctText: pctText(share(k.tokens)),
      entries,
      rest: k.rest ? { label: `${k.rest.count} more`, tokensText: formatTokens(k.rest.tokens) } : null,
      note: entries.length === 0 ? KIND_NOTES[k.kind] ?? null : null,
    });
  }
  if (other > 0) {
    rows.push({
      key: 'other',
      label: otherKinds === 1 ? 'Other' : `Other (${otherKinds} kinds)`,
      tokensText: formatTokens(other),
      pct: share(other),
      pctText: pctText(share(other)),
      entries: folded,
      rest: null,
      note: null,
    });
  }
  if (size && size > b.tokens) {
    const free = size - b.tokens;
    rows.push({ key: 'free', label: 'Free', tokensText: formatTokens(free), pct: share(free), pctText: pctText(share(free)), entries: [], rest: null, note: null });
  }
  const age = b.measuredAt ? formatAge(b.measuredAt, now) : '';
  const since = b.sinceCompaction ? 'since the last compaction' : 'since the session started';
  const requests = `${b.requests} request${b.requests === 1 ? '' : 's'}`;
  return {
    rows,
    items: b.items.map((item, i) => ({ key: `${i}`, label: item.label, tokensText: formatTokens(item.tokens) })),
    note: `Measured from ${requests} ${since}${age ? `, ${age}` : ''}. Each turn’s growth is split across what it added by size.`,
  };
}
