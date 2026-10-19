/**
 * sessionInfoModel.ts — the facts and checks behind a session's Info screen and
 * its actions on the phone (AASC-46). Pure, apart from `sendSessionCommand`.
 *
 * Plain words throughout (principle 7): who is driving, how long it has run,
 * how much of its context is used, the plan's limits.
 */
import type { Session } from '@/types';
import type { ControlBatonMode } from '@/hooks/useControlBaton';
import { restartNeedsConfirm } from '@/lib/restartSession';
import { formatModelLabel } from '@/lib/modelLabel';
import { detectCli } from '@/lib/cliDetect';
import { isCompacting, phoneStatus } from './phoneStatus';
import { describeUsage } from './usageModel';

/** Restart is the terminal toolbar's: the agent's own terminal, never a fork's. */
export function canRestartSession(session: Pick<Session, 'source' | 'terminalId' | 'isFork' | 'status'>): boolean {
  return session.source === 'ssh' && !!session.terminalId && !session.isFork && session.status !== 'ended';
}

/** Why Restart isn't offered, in words (a disabled action says why). */
export function restartBlocker(session: Pick<Session, 'source' | 'terminalId' | 'isFork' | 'status'>): string | null {
  if (canRestartSession(session)) return null;
  if (session.status === 'ended') return 'It has ended: resume it instead.';
  if (session.isFork) return 'A fork can’t be restarted.';
  if (!session.terminalId) return 'It has no terminal on your Mac.';
  return 'Only sessions started from AASC can be restarted.';
}

export function restartMessage(name: string, status: string): string {
  return restartNeedsConfirm(status)
    ? `"${name}" is running right now: the current turn is stopped. It comes back in a new terminal with the same name, model and effort.`
    : `The agent quits and "${name}" comes back in a new terminal with the same name, model and effort.`;
}

export function killMessage(name: string): string {
  return `"${name}" stops: its terminal closes and the agent process ends.`;
}

/** "1h 12m", "4m", "under a minute": how long the session has run (to its end, once ended). */
export function formatRunTime(session: Pick<Session, 'startedAt' | 'endedAt'>, now: number): string {
  const end = session.endedAt ?? now;
  const ms = Math.max(0, end - (session.startedAt ?? end));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m`;
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function cliName(session: Session): string | null {
  const cli = detectCli(session);
  return cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : null;
}

/** "Claude Code · Working · 1h 12m": the Info screen's line under the title. */
export function infoSubtitle(session: Session, now: number): string {
  const { label } = phoneStatus(session.status, !!session.interruption, isCompacting(session));
  return [cliName(session), label, formatRunTime(session, now)].filter(Boolean).join(' · ');
}

/** Why the model can't be changed from here, or null. */
export function modelBlocker(session: Session): string | null {
  if (session.status === 'ended') return 'It has ended.';
  const cli = detectCli(session);
  if (cli !== 'claude' && cli !== 'codex') return 'Only Claude Code and Codex sessions have a model.';
  return null;
}

/** Who drives this session, from this phone's point of view, in plain words. */
export function drivingWords(mode: ControlBatonMode, holderLabel: string | null): string {
  if (mode === 'driver' || mode === 'asked') return 'This phone';
  if (mode === 'spectator' && holderLabel) return holderLabel;
  return 'Nobody right now';
}

/** "Opus 5.5 · high": the live model and effort, else the launch ones, else null. */
export function modelWords(session: Pick<Session, 'model' | 'runtime' | 'effortLevel'>): string | null {
  const model = session.runtime?.model || session.model;
  const effort = session.runtime?.effort || session.effortLevel;
  const words = [model ? formatModelLabel(model) : null, effort].filter(Boolean).join(' · ');
  return words || null;
}

/** "38 %" of the context window, or null when the CLI hasn't said. */
export function contextWords(session: Pick<Session, 'runtime'>): string | null {
  const pct = session.runtime?.context?.pct;
  return typeof pct === 'number' && Number.isFinite(pct) ? `${Math.round(pct)}% used` : null;
}

/**
 * "5-hour 42% · Weekly 61%", or null when no session of this CLI has reported its
 * limits. The desktop chip's rules (describePlanUsage, Oct 20 2026): a window that has
 * reset is dropped, an old reading says so; the words are the Usage sheet's.
 */
export function planWords(session: Session, now: number): string | null {
  const plan = describeUsage(session, now).plan;
  if (!plan) return null;
  if (plan.state !== 'ready') return plan.state === 'expired' ? plan.reason : null;
  const rows = plan.rows.map((r) => `${r.name.charAt(0).toUpperCase()}${r.name.slice(1)} ${r.percentText}`);
  return [...rows, ...(plan.stale ? ['an old reading'] : [])].join(' · ');
}

export type CommandResult = { ok: true } | { ok: false; error: string };

let keySeq = 0;
function requestKey(): string {
  keySeq += 1;
  return `info-${Date.now().toString(36)}-${keySeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Type a slash command into the session through the Mac (`POST /sessions/:id/prompt`,
 * AASC-42): `/model sonnet`, `/effort high`. The Mac checks visibility, the baton and
 * that the agent is the terminal's foreground program, and says why when it refuses.
 * Never throws.
 */
export async function sendSessionCommand(sessionId: string, text: string): Promise<CommandResult> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: 'now', key: requestKey() }),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: body?.error || `Your Mac refused it (HTTP ${res.status})` };
  } catch {
    return { ok: false, error: 'Couldn’t reach your Mac.' };
  }
}
