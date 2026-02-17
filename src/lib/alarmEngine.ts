/**
 * AlarmEngine manages approval/input alarms and label-based completion alerts.
 * Ported from public/js/alarmManager.js.
 *
 * - Approval alarm: repeating sound every 10s while session is in 'approval' status
 * - Input notification: one-time sound when session enters 'input' status
 * - Label alerts: sound + movement when a labeled session ends
 * - Event sounds: maps hook events to sound actions
 */
import type { Session, SessionEvent } from '@/types';
import type { SoundAction } from './soundEngine';
import { soundEngine } from './soundEngine';

// ---------------------------------------------------------------------------
// Tool name -> sound action mapping
// ---------------------------------------------------------------------------

const TOOL_SOUND_MAP: Record<string, SoundAction> = {
  Read: 'toolRead',
  Write: 'toolWrite',
  Edit: 'toolEdit',
  Bash: 'toolBash',
  Grep: 'toolGrep',
  Glob: 'toolGlob',
  WebFetch: 'toolWebFetch',
  Task: 'toolTask',
};

// ---------------------------------------------------------------------------
// Alarm state
// ---------------------------------------------------------------------------

/** sessionId -> intervalId for repeating approval alarm */
const approvalTimers = new Map<string, ReturnType<typeof setInterval>>();

/** 'input-' + sessionId -> true for one-shot input notification */
const inputFired = new Map<string, true>();

/** Set of muted session IDs (managed externally) */
const mutedSessions = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Mark a session as muted (no alarm sounds). */
export function muteSession(sessionId: string): void {
  mutedSessions.add(sessionId);
}

/** Unmark a session from mute. */
export function unmuteSession(sessionId: string): void {
  mutedSessions.delete(sessionId);
}

/** Check if a session is currently muted. */
export function isMuted(sessionId: string): boolean {
  return mutedSessions.has(sessionId);
}

/** Clear all alarm timers for a session. */
export function clearAlarm(sessionId: string): void {
  const timer = approvalTimers.get(sessionId);
  if (timer != null) {
    clearInterval(timer);
    approvalTimers.delete(sessionId);
  }
  inputFired.delete(`input-${sessionId}`);
}

/** Clear all alarms globally (e.g., on page unload). */
export function clearAllAlarms(): void {
  for (const timer of approvalTimers.values()) {
    clearInterval(timer);
  }
  approvalTimers.clear();
  inputFired.clear();
}

/**
 * Handle event-based sounds for a session update.
 * Call this when a session receives new events.
 */
export function handleEventSounds(session: Session): void {
  const events = session.events;
  if (!events || events.length === 0) return;
  if (mutedSessions.has(session.sessionId)) return;

  const lastEvt = events[events.length - 1];
  if (!lastEvt) return;

  switch (lastEvt.type) {
    case 'SessionStart':
      soundEngine.play('sessionStart');
      break;
    case 'UserPromptSubmit':
      soundEngine.play('promptSubmit');
      break;
    case 'PreToolUse': {
      const toolName = (lastEvt as SessionEvent & { tool_name?: string }).tool_name || '';
      const action = TOOL_SOUND_MAP[toolName] || 'toolOther';
      soundEngine.play(action);
      break;
    }
    case 'Stop':
      soundEngine.play('taskComplete');
      break;
    case 'SessionEnd':
      soundEngine.play('sessionEnd');
      break;
    case 'SubagentStart':
      soundEngine.play('subagentStart');
      break;
    case 'SubagentStop':
      soundEngine.play('subagentStop');
      break;
  }
}

/**
 * Check and manage approval/input alarms for a session.
 * Call this on every session update to start/stop alarms.
 */
export function checkAlarms(
  session: Session,
  getSessions: () => Map<string, Session>,
): void {
  const sid = session.sessionId;

  // ---- Approval alarm (repeating every 10s) ----
  if (session.status === 'approval' && !mutedSessions.has(sid)) {
    if (!approvalTimers.has(sid)) {
      soundEngine.play('approvalNeeded');
      const intervalId = setInterval(() => {
        const current = getSessions().get(sid);
        if (!current || current.status !== 'approval' || mutedSessions.has(sid)) {
          clearInterval(intervalId);
          approvalTimers.delete(sid);
          return;
        }
        soundEngine.play('approvalNeeded');
      }, 10_000);
      approvalTimers.set(sid, intervalId);
    }
  } else if (session.status !== 'approval' && approvalTimers.has(sid)) {
    const timer = approvalTimers.get(sid)!;
    clearInterval(timer);
    approvalTimers.delete(sid);
  }

  // ---- Input notification (one-shot) ----
  const inputKey = `input-${sid}`;
  if (session.status === 'input' && !mutedSessions.has(sid)) {
    if (!inputFired.has(inputKey)) {
      soundEngine.play('inputNeeded');
      inputFired.set(inputKey, true);
    }
  } else if (session.status !== 'input') {
    inputFired.delete(inputKey);
  }
}

/**
 * Handle label-based completion alerts.
 * Call this when a labeled session transitions to 'ended'.
 */
export function handleLabelAlerts(
  session: Session,
  labelSettings: Record<string, { sound?: string; movement?: string; frame?: string }>,
): void {
  if (session.status !== 'ended') return;
  if (mutedSessions.has(session.sessionId)) return;

  const labelUpper = (session.label || '').toUpperCase();
  const cfg = labelSettings[labelUpper];
  if (!cfg) return;

  if (cfg.sound && cfg.sound !== 'none') {
    soundEngine.preview(cfg.sound as Parameters<typeof soundEngine.preview>[0]);
  }
}
