/**
 * True when the session's current status indicates the CLI prompt box is
 * ready to receive a new prompt. 'idle' is included because slash commands
 * (/clear, /compact) and post-2-minute auto-idle leave the session in this
 * state while the CLI is still ready to receive input.
 *
 * Its own import-free module so the `aasc` terminal client (cli/client) uses the
 * queue's exact rule without pulling the queue's store types in; queueScheduler.ts
 * re-exports it for every existing caller.
 */
export function isSendableStatus(status: string): boolean {
  return status === 'waiting' || status === 'input' || status === 'idle';
}
