/**
 * @module sessionHookLevel
 * The client half of the per-session Automation mark (lite hooks; server/sessionHookLevel.ts): whether a
 * session can take it, and what to tell the person after a change. Import-free of React and the stores.
 */
import type { Session } from '@/types';

const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/** True when the session's agent runs on this computer, where its PTY can carry the lite-hooks variable. */
export function canUseAutomation(session: Pick<Session, 'sshConfig'>): boolean {
  const host = session.sshConfig?.host;
  return !host || LOCAL_HOSTS.has(host);
}

/** True when the session is marked Automation. */
export function isAutomation(session: Pick<Session, 'hookLevel'>): boolean {
  return session.hookLevel === 'lite';
}

/**
 * The toast after a change. `appliesOnRestart`: an agent is running in a terminal and keeps its old level
 * until its next launch, so the message says so (the toast offers Restart now).
 */
export function automationChangedMessage(on: boolean, appliesOnRestart: boolean): string {
  const what = on ? 'Automation on: lite hooks' : 'Automation off: full hooks';
  return appliesOnRestart ? `${what} from the next launch` : what;
}
