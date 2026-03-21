/**
 * AlarmEngine manages approval/input alarms.
 * Ported from public/js/alarmManager.js.
 *
 * - Approval alarm: repeating sound every 10s while session is in 'approval' status
 * - Input notification: one-time sound when session enters 'input' status
 * - Event sounds: maps hook events to sound actions
 */
import type { Session, SessionEvent } from '@/types';
import type { SoundAction, SoundName } from './soundEngine';
import { soundEngine } from './soundEngine';
import { useSettingsStore } from '@/stores/settingsStore';
import { detectCli } from './cliDetect';

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

/** Set of alerted session IDs — play louder, more noticeable sounds */
const alertedSessions = new Set<string>();

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

/** Mark a session as alerted (loud sounds for approval/completion). */
export function alertSession(sessionId: string): void {
  alertedSessions.add(sessionId);
}

/** Remove alert from a session. */
export function unalertSession(sessionId: string): void {
  alertedSessions.delete(sessionId);
}

/** Check if a session has alert enabled. */
export function isAlerted(sessionId: string): boolean {
  return alertedSessions.has(sessionId);
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

/** Volume boost multiplier for alerted sessions (capped at 1.0) */
const ALERT_VOLUME_BOOST = 2.5;

/** Approval alarm repeat interval for alerted sessions (faster) */
const ALERT_APPROVAL_INTERVAL = 5_000;

/** Normal approval alarm repeat interval */
const NORMAL_APPROVAL_INTERVAL = 10_000;

/**
 * Resolve the sound to play for a given action, respecting per-CLI profiles.
 * Falls back to the global soundEngine.play() if no CLI match or CLI is disabled.
 * Alerted sessions play at boosted volume.
 */
function playForCli(session: Session, action: SoundAction): void {
  const state = useSettingsStore.getState();
  if (!state.soundSettings.enabled) return;

  const isAlert = alertedSessions.has(session.sessionId);

  // Determine CLI name from model + events (session.source is terminal type, not CLI)
  const cli = detectCli(session);
  const perCli = state.soundSettings.perCli;
  const cliConfig = cli ? perCli[cli] : undefined;

  if (cliConfig && cliConfig.enabled) {
    const soundName = (cliConfig.actions[action] ?? 'none') as SoundName;
    if (soundName !== 'none') {
      const prevVol = soundEngine.getVolume();
      const baseVol = state.soundSettings.volume * cliConfig.volume;
      soundEngine.setVolume(isAlert ? Math.min(1, baseVol * ALERT_VOLUME_BOOST) : baseVol);
      soundEngine.preview(soundName);
      soundEngine.setVolume(prevVol);
    }
    return;
  }

  // Fallback: use global sound engine defaults, boosted for alerted sessions
  if (isAlert) {
    const prevVol = soundEngine.getVolume();
    soundEngine.setVolume(Math.min(1, state.soundSettings.volume * ALERT_VOLUME_BOOST));
    soundEngine.play(action);
    soundEngine.setVolume(prevVol);
  } else {
    soundEngine.play(action);
  }
}

/**
 * Handle event-based sounds for a session update.
 * Call this when a session receives new events.
 */
export function handleEventSounds(session: Session): void {
  const events = session.events;
  if (!events || events.length === 0) return;
  // Muted sessions never play sounds (unless alerted — alert overrides mute)
  if (mutedSessions.has(session.sessionId) && !alertedSessions.has(session.sessionId)) return;

  const lastEvt = events[events.length - 1];
  if (!lastEvt) return;

  switch (lastEvt.type) {
    case 'SessionStart':
      playForCli(session, 'sessionStart');
      break;
    case 'UserPromptSubmit':
      playForCli(session, 'promptSubmit');
      break;
    case 'PreToolUse': {
      const toolName = (lastEvt as SessionEvent & { tool_name?: string }).tool_name || '';
      const action = TOOL_SOUND_MAP[toolName] || 'toolOther';
      playForCli(session, action);
      break;
    }
    case 'Stop':
      playForCli(session, 'taskComplete');
      break;
    case 'SessionEnd':
      playForCli(session, 'sessionEnd');
      break;
    case 'SubagentStart':
      playForCli(session, 'subagentStart');
      break;
    case 'SubagentStop':
      playForCli(session, 'subagentStop');
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

  // ---- Approval alarm (repeating) ----
  // Alerted sessions repeat every 5s; normal sessions every 10s
  const interval = alertedSessions.has(sid) ? ALERT_APPROVAL_INTERVAL : NORMAL_APPROVAL_INTERVAL;
  if (session.status === 'approval' && !mutedSessions.has(sid)) {
    if (!approvalTimers.has(sid)) {
      playForCli(session, 'approvalNeeded');
      const intervalId = setInterval(() => {
        const current = getSessions().get(sid);
        if (!current || current.status !== 'approval' || mutedSessions.has(sid)) {
          clearInterval(intervalId);
          approvalTimers.delete(sid);
          return;
        }
        playForCli(current, 'approvalNeeded');
      }, interval);
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
      playForCli(session, 'inputNeeded');
      inputFired.set(inputKey, true);
    }
  } else if (session.status !== 'input') {
    inputFired.delete(inputKey);
  }
}
