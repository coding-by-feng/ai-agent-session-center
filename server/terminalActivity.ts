/**
 * @module terminalActivity
 * When each agent terminal last printed anything.
 *
 * Hook silence alone cannot tell a prompt that never ran from a turn that is
 * busy without firing hooks — Claude thinking or writing before its first tool
 * call, or a whole turn at Low hook density. A live turn keeps printing (its
 * spinner, timer and streamed text); a prompt that never ran does not. The
 * `prompting` auto-decay in autoIdleManager reads this to tell them apart.
 *
 * Import-free on purpose: written from the PTY `onData` hot path in
 * sshManager and read by autoIdleManager, without either importing the other.
 */

const lastOutputAt = new Map<string, number>();

/** Record output on a terminal. Cheap enough for every PTY chunk. */
export function noteTerminalOutput(terminalId: string, now: number = Date.now()): void {
  lastOutputAt.set(terminalId, now);
}

/** Last output time for a terminal, or undefined if it never printed / is unknown. */
export function terminalLastOutputAt(terminalId: string | null | undefined): number | undefined {
  return terminalId ? lastOutputAt.get(terminalId) : undefined;
}

/** Forget a terminal. Call on terminal close. */
export function forgetTerminalOutput(terminalId: string): void {
  lastOutputAt.delete(terminalId);
}

/** Test-only: wipe all recorded activity. */
export function resetTerminalActivity(): void {
  lastOutputAt.clear();
}
