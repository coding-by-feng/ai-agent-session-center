/**
 * useWorkingStatus — what the agent is doing now, for the phone's status chip, the open
 * peek's header and full-screen Chat's strip (AASC-41; moved out of StatusStrip Nov 13 2026):
 *
 *   Working · Bash · 0:42            the turn's newest tool, timed from its prompt
 *   Starting · 0:05                  prompted, no tool yet
 *   Compacting context · auto · 0:23 timed from PreCompact
 *   Finishing up · Stop hooks · 0:12 the answer is in, Claude still runs its Stop hooks (Nov 6
 *                                    2026); a prompt sent now waits, unseen, until they finish
 *   Stopping · Bash · 0:44           Esc was written (useAgentStop)
 *
 * Status and tool come from the session object (hook-driven, instant), not the transcript.
 * One shared 1 s clock serves every caller, so the chip, the ■ and the peek header never
 * disagree by a second; a caller listens only while its session may be busy, so an idle
 * composer doesn't re-render, and the clock restarts fresh rather than from a stale time.
 */
import { useSyncExternalStore } from 'react';
import type { Session } from '@/types';
import { formatDuration } from '@/lib/chat/chatFormat';
import { isCompacting, isFinishingUp } from '@/lib/chat/phoneStatus';
import { isStopPending, useStopSent } from './useAgentStop';

const TICK_MS = 1000;

let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | null = null;
const clockListeners = new Set<() => void>();

function tick(): void {
  clockNow = Date.now();
  for (const listener of clockListeners) listener();
}

/** Runs while anyone listens; the first listener restarts it from the real time. */
function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(tick, TICK_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const getClock = () => clockNow;
const stayStill = () => () => {};

export interface WorkingStatus {
  /** Something to show: working, starting, compacting or finishing up. */
  live: boolean;
  label: string;
  tool: string | null;
  /** "0:42", or '' under a second. */
  elapsed: string;
  /** When this turn (or compaction, or Stop) began: the key a written Stop belongs to. */
  turn: number;
  /** Claude runs its Stop hooks: no Stop (Esc there cancels them, and the answer is in). */
  finishing: boolean;
  stopPending: boolean;
}

/** When the current turn began: the last prompt, else the last activity. */
function turnStart(session: Session): number {
  const prompts = session.promptHistory;
  const last = prompts && prompts.length > 0 ? prompts[prompts.length - 1].timestamp : 0;
  return last || session.lastActivityAt || Date.now();
}

/** The tool in use now, if the newest call belongs to this turn. */
function currentTool(session: Session, since: number): string | null {
  const log = session.toolLog;
  const last = log && log.length > 0 ? log[log.length - 1] : null;
  return last && last.timestamp >= since ? last.tool : null;
}

export function useWorkingStatus(session: Session): WorkingStatus {
  const stopSent = useStopSent(session.sessionId);
  // May the session be busy? Only then does this caller listen to the clock. A mark gone
  // stale counts as not busy (judged by the last reading, so a fresh mark always counts:
  // it lies after that reading).
  const last = getClock();
  const mayBeBusy = session.status === 'working' || session.status === 'prompting'
    || isCompacting(session, last) || isFinishingUp(session, last);
  const now = useSyncExternalStore(mayBeBusy ? subscribeClock : stayStill, getClock, getClock);

  const compacting = isCompacting(session, now) ? session.compacting ?? null : null;
  const finishingSince = !compacting && isFinishingUp(session, now) ? session.stopHooksSince ?? null : null;
  const turn = compacting ? compacting.since : finishingSince ?? turnStart(session);
  const tool = compacting || finishingSince ? null : currentTool(session, turn);
  const elapsed = formatDuration(Math.max(0, now - turn));
  // Worked out on each tick, never set by an effect: a new turn or the timeout ends it.
  const stopPending = isStopPending(stopSent, turn, now);
  // A mark gone stale with no update (the session sits waiting) must not fall back to
  // "Working · <the turn's last tool>".
  const live = session.status === 'working' || session.status === 'prompting' || !!compacting || finishingSince !== null;
  const label = stopPending
    ? 'Stopping'
    : compacting
      ? ['Compacting context', compacting.trigger].filter(Boolean).join(' · ')
      : finishingSince !== null
        ? 'Finishing up · Stop hooks'
        : session.status === 'prompting' ? 'Starting' : 'Working';

  return { live, label, tool, elapsed, turn, finishing: finishingSince !== null, stopPending };
}

/** The status as one spoken line: "Working · Bash · for 0:42". */
export function spokenStatus(status: WorkingStatus): string {
  return [status.label, status.tool, status.elapsed ? `for ${status.elapsed}` : null].filter(Boolean).join(' · ');
}
