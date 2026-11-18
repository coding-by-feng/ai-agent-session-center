/**
 * AlarmEngine manages approval/input alarms.
 * Ported from public/js/alarmManager.js.
 *
 * - Approval alarm: repeating sound every 10s while session is in 'approval' status
 * - Input notification: one-time sound when session enters 'input' status
 * - Event sounds: maps hook events to sound actions, once per event
 * - Alert (Nov 18 2026): an alerted session sounds a loud siren for approval (every 5 s) and loud
 *   bells for completion, over mute, the global sound switch and the CLI's own mapping
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

/** Sessions muted by a click in this window (the session's own `muted` flag wins once it has one). */
const mutedSessions = new Set<string>();

/** Sessions alerted by a click in this window (the session's own `alerted` flag wins once it has one). */
const alertedSessions = new Set<string>();

/**
 * Alert is the session's flag (the server keeps it and restores it), so it holds after a reload and
 * when it was set on another device. This window's click counts only while the session has no flag yet.
 */
function alertOn(session: Session): boolean {
  return session.alerted ?? alertedSessions.has(session.sessionId);
}

function mutedOn(session: Session): boolean {
  return session.muted ?? mutedSessions.has(session.sessionId);
}

/** Has this event already made its sound? Same type and time as the previous update's last event. */
function sameEvent(a: SessionEvent | undefined, b: SessionEvent | undefined): boolean {
  return !!a && !!b && a.type === b.type && a.timestamp === b.timestamp;
}

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

/** Approval alarm repeat interval for alerted sessions (faster) */
const ALERT_APPROVAL_INTERVAL = 5_000;

/** Normal approval alarm repeat interval */
const NORMAL_APPROVAL_INTERVAL = 10_000;

/**
 * Resolve the sound to play for a given action, respecting per-CLI profiles.
 * Falls back to the global soundEngine.play() if no CLI match or CLI is disabled.
 */
function playForCli(session: Session, action: SoundAction): void {
  const state = useSettingsStore.getState();
  if (!state.soundSettings.enabled) return;

  // Determine CLI name from model + events (session.source is terminal type, not CLI)
  const cli = detectCli(session);
  const perCli = state.soundSettings.perCli;
  const cliConfig = cli ? perCli[cli] : undefined;

  if (cliConfig && cliConfig.enabled) {
    const soundName = (cliConfig.actions[action] ?? 'none') as SoundName;
    if (soundName !== 'none') {
      const prevVol = soundEngine.getVolume();
      soundEngine.setVolume(state.soundSettings.volume * cliConfig.volume);
      soundEngine.preview(soundName);
      soundEngine.setVolume(prevVol);
    }
    return;
  }

  soundEngine.play(action);
}

/**
 * Handle event-based sounds for a session update. Pass the session as it was before this update
 * (`prev`), so an update that still ends on the same event (a status decay, a title) stays quiet.
 */
export function handleEventSounds(session: Session, prev?: Session): void {
  const events = session.events;
  if (!events || events.length === 0) return;
  const lastEvt = events[events.length - 1];
  if (!lastEvt) return;
  if (sameEvent(lastEvt, prev?.events?.[prev.events.length - 1])) return;

  const alert = alertOn(session);
  // An alerted session's completion: loud bells, heard over mute and over sounds being off.
  if (alert && lastEvt.type === 'Stop') {
    soundEngine.playLoud('bells');
    return;
  }
  // Muted sessions never play sounds (unless alerted — alert overrides mute)
  if (mutedOn(session) && !alert) return;

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
      // A session AASC put to sleep (server/sessionSleep.ts) ends quietly; a sweep can sleep many at once.
      if (!session.asleepAt) playForCli(session, 'sessionEnd');
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
  // Alerted sessions: the loud siren every 5s, over mute; normal sessions: their sound every 10s.
  const audible = (s: Session) => alertOn(s) || !mutedOn(s);
  const approvalSound = (s: Session) => {
    if (alertOn(s)) soundEngine.playLoud('siren');
    else playForCli(s, 'approvalNeeded');
  };
  const interval = alertOn(session) ? ALERT_APPROVAL_INTERVAL : NORMAL_APPROVAL_INTERVAL;
  if (session.status === 'approval' && audible(session)) {
    if (!approvalTimers.has(sid)) {
      approvalSound(session);
      const intervalId = setInterval(() => {
        const current = getSessions().get(sid);
        if (!current || current.status !== 'approval' || !audible(current)) {
          clearInterval(intervalId);
          approvalTimers.delete(sid);
          return;
        }
        approvalSound(current);
      }, interval);
      approvalTimers.set(sid, intervalId);
    }
  } else if (approvalTimers.has(sid)) {
    // Answered, or muted with Alert off: stop the repeat.
    const timer = approvalTimers.get(sid)!;
    clearInterval(timer);
    approvalTimers.delete(sid);
  }

  // ---- Input notification (one-shot) ----
  const inputKey = `input-${sid}`;
  if (session.status === 'input' && !mutedOn(session)) {
    if (!inputFired.has(inputKey)) {
      playForCli(session, 'inputNeeded');
      inputFired.set(inputKey, true);
    }
  } else if (session.status !== 'input') {
    inputFired.delete(inputKey);
  }
}
