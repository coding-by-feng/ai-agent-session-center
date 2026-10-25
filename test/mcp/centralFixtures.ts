// test/mcp/centralFixtures.ts — what the central registry and lifecycle tests share: launch inputs for
// the three kinds of central, the marker a session carries, and stand-ins for the two feeds the
// lifecycle watcher listens to (`onBroadcast` and the terminal-exit feed).
import type { MintInput } from '../../server/mcp/centrals.js';
import type { SessionCentralMarker } from '../../server/mcp/types.js';

export const globalInput = (over: Partial<MintInput> = {}): MintInput => ({
  kind: 'global',
  scopeRef: null,
  cli: 'claude',
  permissionMode: null,
  ...over,
});

export const roomInput = (roomId: string | null, over: Partial<MintInput> = {}): MintInput => ({
  kind: 'room',
  scopeRef: roomId,
  cli: 'claude',
  permissionMode: null,
  ...over,
});

export const projectInput = (folder: string | null, over: Partial<MintInput> = {}): MintInput => ({
  kind: 'project',
  scopeRef: folder,
  cli: 'claude',
  permissionMode: null,
  ...over,
});

/** Builds the `central` marker a session carries (centrals.ts has a private reader of that field). */
export const makeMarker = (centralId: string): SessionCentralMarker => ({
  centralId,
  kind: 'global',
  scopeRef: null,
});

/** A broadcast message, the way `onBroadcast` hands it to its listeners. */
export type BusMessage = { type: string; [key: string]: unknown };

/** A stand-in for `onBroadcast`: `emit` plays the messages the server would send. */
export function fakeBus() {
  const listeners = new Set<(msg: BusMessage) => void>();
  return {
    subscribe(listener: (msg: BusMessage) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(msg: BusMessage): void {
      for (const listener of [...listeners]) listener(msg);
    },
    listenerCount: () => listeners.size,
  };
}

/** What the server broadcasts when a session changes. */
export const sessionUpdate = (session: Record<string, unknown>): BusMessage => ({
  type: 'session_update',
  session,
});

/** What a terminal's own subscribers receive when its PTY exits. */
export const terminalClosed = (terminalId: string): BusMessage => ({
  type: 'terminal_closed',
  terminalId,
  reason: 'exited',
});

/**
 * What the server broadcasts when a session carrying a central's marker has ended. `terminalId` is
 * the terminal the card is on: a live card keeps it after the agent exits, a card whose PTY is gone
 * has null.
 */
export const endedUpdate = (centralId: string, terminalId: string | null): BusMessage =>
  sessionUpdate({
    sessionId: 'claude-uuid',
    status: 'ended',
    terminalId,
    central: makeMarker(centralId),
  });

/** A stand-in for the terminal-exit feed: `exit` plays a PTY exiting. */
export function fakeTerminalExits() {
  const listeners = new Set<(terminalId: string) => void>();
  return {
    subscribe(listener: (terminalId: string) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    exit(terminalId: string): void {
      for (const listener of [...listeners]) listener(terminalId);
    },
    listenerCount: () => listeners.size,
  };
}
