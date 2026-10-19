/**
 * What the session header's model · effort chip shows (`SessionRuntimeChip`).
 *
 * Prefers what the CLI reported it is running with now (`session.runtime`, kept by
 * `server/sessionRuntime.ts`) and falls back to what the dashboard launched it with
 * (`session.model` / `session.effortLevel`), saying which one it is.
 */
import type { Session } from '@/types';
import { detectCli } from '@/lib/cliDetect';
import { formatModelLabel } from '@/lib/modelLabel';

export interface RuntimeDisplay {
  /** Short label, e.g. "Opus 5.5". */
  model: string;
  /** Undefined = unknown (no launch value, or the CLI made it unknown with a model switch). */
  effort: string | undefined;
  /** The model came from the CLI's own report, not the launch value. */
  live: boolean;
  /** The effort came from the CLI's own report (including "unknown since a switch"). */
  effortLive: boolean;
}

/** `null` = no chip (Codex has no `/effort` and reports neither, or there is no model at all). */
export function resolveRuntimeDisplay(session: Session): RuntimeDisplay | null {
  if (detectCli(session) === 'codex') return null;
  const runtime = session.runtime;
  const live = runtime?.model !== undefined;
  const model = formatModelLabel(runtime?.model ?? session.model ?? '');
  if (!model) return null;
  // Once the CLI has said anything about effort — even "unknown since this switch" — the
  // launch value is history: falling back to it would show an effort the session no longer has.
  const effortLive = runtime?.effortAt !== undefined;
  const effort = effortLive ? runtime?.effort : session.effortLevel || undefined;
  return { model, effort, live, effortLive };
}

/** Context-window bands. Claude auto-compacts near the top, so 90% means "soon". */
export const CONTEXT_WARN_PCT = 70;
export const CONTEXT_HIGH_PCT = 90;

export interface ContextDisplay {
  pct: number;
  level: 'ok' | 'warn' | 'high';
  size?: number;
  tokens?: number;
}

/**
 * `null` = no context segment: not reported yet (never shown as 0%). Claude Code reports it
 * through the status-line tap, Codex through its rollout's `token_count` (since Oct 20 2026).
 */
export function resolveContextDisplay(session: Session): ContextDisplay | null {
  const context = session.runtime?.context;
  if (!context) return null;
  const level = context.pct >= CONTEXT_HIGH_PCT ? 'high' : context.pct >= CONTEXT_WARN_PCT ? 'warn' : 'ok';
  return { ...context, level };
}
