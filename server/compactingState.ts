// compactingState.ts — is a session compacting its context right now? (the phone's hint)
//
// Both CLIs fire PreCompact before a compaction, with `trigger` 'manual' (/compact) or
// 'auto'. The end differs: Codex fires PostCompact, Claude Code fires SessionStart with
// source 'compact'. Any later turn event also means it is over, which covers a lost end
// hook and a compaction cancelled with Esc. The status is left alone on purpose: an idle
// compaction is still idle to the queue, which must not read it as a turn.

import { EVENT_TYPES } from './constants.js';
import type { SessionCompacting } from '../src/types/session.js';

const ENDS_COMPACTION: ReadonlySet<string> = new Set([
  EVENT_TYPES.POST_COMPACT,
  EVENT_TYPES.SESSION_START,
  EVENT_TYPES.USER_PROMPT_SUBMIT,
  EVENT_TYPES.PRE_TOOL_USE,
  EVENT_TYPES.STOP,
  EVENT_TYPES.AGENT_TURN_COMPLETE,
  EVENT_TYPES.SESSION_END,
]);

function triggerOf(hookData: Record<string, unknown>): SessionCompacting['trigger'] {
  const t = hookData.trigger;
  return t === 'auto' || t === 'manual' ? t : null;
}

/** The session's `compacting` after this hook: a new value, null, or `prev` unchanged. */
export function nextCompacting(
  prev: SessionCompacting | null,
  eventName: string,
  hookData: Record<string, unknown>,
  now: number,
): SessionCompacting | null {
  if (eventName === EVENT_TYPES.PRE_COMPACT) return { since: now, trigger: triggerOf(hookData) };
  if (prev && ENDS_COMPACTION.has(eventName)) return null;
  return prev;
}
