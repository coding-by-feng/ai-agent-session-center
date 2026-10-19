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
import { detectCli } from '@/lib/cliDetect';
import { describePlanUsage, type PlanUsageView } from '@/lib/planUsage';
import { resolveContextDisplay, type ContextDisplay } from '@/lib/sessionRuntime';

export interface UsageContext {
  pct: number;
  /** "59%" */
  pctText: string;
  level: ContextDisplay['level'];
  /** "118k of 200k tokens", or null when the CLI gave only the %. */
  tokensText: string | null;
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
  return { context, plan, chip, ariaLabel: parts.join(' ').replace(/\.\./g, '.') };
}
