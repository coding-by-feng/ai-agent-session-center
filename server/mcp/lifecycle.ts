// lifecycle.ts — revokes a central's token when the terminal it runs in goes away.
//
// What the watcher listens to is passed in, so it needs no running server:
//   subscribeTerminalExit  each terminal that is gone, by id: `onTerminalExit` in sshManager. It fires
//                          when a PTY exits by itself and when a terminal is closed on purpose (kill,
//                          close, delete, restart), which is how a central's terminal ends in practice.
//   subscribe              the server's messages: wsManager's `onBroadcast`.
// `onBroadcast` does not carry `terminal_closed` (sshManager sends it only to the terminal's own
// subscribers), so on the server exits arrive on the second feed. A `terminal_closed` message on the
// first is still honoured, and does what an exit does.
//
// A central is revoked when the terminal it is attached to goes away, and for no other reason.
//
// What does not revoke it:
//   - a session ending (`session_update` with status `ended`). Claude's `/clear` fires SessionEnd while
//     the CLI, and the MCP connection it holds, keep running; and a token that outlives a CLI which has
//     quit, in a shell that is still open, grants nothing a local process does not already have. The
//     terminal going away is the end.
//   - `session_removed`. A removed card is not the end of its central: its terminal either closed,
//     which the exit above catches, or moved to another card. A restore absorbs the fresh card into
//     the old one and removes a card while the PTY lives on.
//   - the exit of an old terminal after a relaunch. A restart attaches the replacement PTY to the
//     central first and stops the old one afterwards, so the old id no longer names the central.
//
// Revoking is safe to repeat.

import { WS_TYPES } from '../constants.js';
import log from '../logger.js';
import type { CentralRegistry } from './centrals.js';

/** A broadcast message, the way `onBroadcast` hands it to its listeners. */
export type LifecycleMessage = { type: string; [key: string]: unknown };

/** Starts a listener and returns the function that stops it: `onBroadcast`'s shape. */
export type LifecycleSubscribe = (listener: (msg: LifecycleMessage) => void) => () => void;

/** The same shape for terminals going away: the listener gets the id of the terminal that is gone. */
export type TerminalExitSubscribe = (listener: (terminalId: string) => void) => () => void;

/**
 * Start watching. Returns the function that stops it, which detaches both feeds (once, however
 * often it is called). Without `subscribeTerminalExit` only the messages are watched. When the exit
 * feed cannot be subscribed, the message feed is detached again and the error is thrown: a watcher
 * is on both feeds or on neither.
 */
export function watchCentralLifecycle(
  reg: CentralRegistry,
  subscribe: LifecycleSubscribe,
  subscribeTerminalExit?: TerminalExitSubscribe,
): () => void {
  function onTerminalExit(terminalId: string): void {
    const central = reg.byTerminal(terminalId);
    if (central === null) return;
    reg.revoke(central.centralId);
    log.info('mcp', `Central ${central.centralId} revoked: terminal ${terminalId} closed`);
  }

  const stopMessages = subscribe((msg) => {
    if (msg.type === WS_TYPES.TERMINAL_CLOSED && typeof msg.terminalId === 'string') {
      onTerminalExit(msg.terminalId);
    }
  });
  let stopExits: (() => void) | undefined;
  try {
    stopExits = subscribeTerminalExit?.(onTerminalExit);
  } catch (err) {
    stopMessages();
    throw err;
  }

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopMessages();
    stopExits?.();
  };
}
