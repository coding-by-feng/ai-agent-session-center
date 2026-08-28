/**
 * @module ptySubscribers
 *
 * Fan PTY output out to every socket watching a terminal, pruning the dead ones.
 *
 * Terminals used to hold a SINGLE `wsClient` reference, which made them
 * last-subscriber-wins: opening the dashboard on a second device silently stole
 * the output stream from the first, whose terminal then sat frozen with no
 * error raised anywhere. A Set of subscribers is what lets two devices watch
 * one PTY at once — reads are shared; only WRITES are arbitrated, by
 * `presenceManager`'s per-session baton.
 *
 * That change moves a real hazard here, though: a single reference was
 * self-cleaning (the next subscriber overwrote it), while a Set retains every
 * socket that ever joined. Pruning is therefore part of the send path and not
 * an optional tidy-up — see `fanOutToSockets`.
 *
 * Kept import-free and free of `ws` types so it can be unit-tested without
 * loading node-pty (which `sshManager` pulls in at module scope).
 */

/** The slice of a WebSocket this module needs. Structural, so tests can fake it. */
export interface SubscriberSocket {
  /** 0 CONNECTING · 1 OPEN · 2 CLOSING · 3 CLOSED */
  readyState: number;
  send(data: string): void;
}

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export interface FanOutResult {
  /** Sockets that received the payload. */
  sent: number;
  /** Sockets dropped from the set because they had closed. */
  pruned: number;
}

/**
 * Send `payload` to every OPEN socket and drop the closed ones from `clients`.
 *
 * Two details that look incidental and are not:
 *
 *  - **CONNECTING (0) is never pruned.** A socket mid-handshake is not dead;
 *    evicting it would unsubscribe a device during its own connect and leave it
 *    with a permanently blank terminal that only a reload fixes.
 *
 *  - **A throwing `send` prunes.** `ws` can throw on a socket that closed
 *    between the readyState check and the write. Without this, one wedged
 *    socket would throw on every chunk of PTY output forever, and — because the
 *    loop would abort — starve every subscriber after it in iteration order.
 */
export function fanOutToSockets(
  clients: Set<SubscriberSocket>,
  payload: string,
): FanOutResult {
  let sent = 0;
  let pruned = 0;
  for (const client of clients) {
    if (client.readyState === WS_OPEN) {
      try {
        client.send(payload);
        sent++;
      } catch {
        clients.delete(client);
        pruned++;
      }
    } else if (client.readyState === WS_CLOSING || client.readyState === WS_CLOSED) {
      clients.delete(client);
      pruned++;
    }
  }
  return { sent, pruned };
}
