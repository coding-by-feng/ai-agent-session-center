// test/ptySubscribers.test.ts — PTY output fan-out to multiple devices.
//
// Terminals held a SINGLE `wsClient` reference, so subscribing from a second
// device silently stole the stream from the first: its terminal froze with no
// error anywhere. Making subscribers a Set fixes that, but moves a hazard into
// this module — a single reference was self-cleaning (the next subscriber
// overwrote it), while a Set keeps every socket that ever joined. Pruning is
// therefore part of the send path, and these tests pin the three edges that are
// easy to get subtly wrong.
import { describe, it, expect, vi } from 'vitest';
import {
  fanOutToSockets,
  WS_CONNECTING,
  WS_OPEN,
  WS_CLOSING,
  WS_CLOSED,
  type SubscriberSocket,
} from '../server/ptySubscribers.js';

function sock(readyState: number): SubscriberSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState, send: vi.fn() };
}

describe('fanOutToSockets', () => {
  it('delivers to every open socket — the whole point of multi-device viewing', () => {
    const desktop = sock(WS_OPEN);
    const phone = sock(WS_OPEN);
    const clients = new Set<SubscriberSocket>([desktop, phone]);

    const result = fanOutToSockets(clients, 'chunk');

    expect(desktop.send).toHaveBeenCalledWith('chunk');
    expect(phone.send).toHaveBeenCalledWith('chunk');
    expect(result).toEqual({ sent: 2, pruned: 0 });
    expect(clients.size).toBe(2);
  });

  it('prunes CLOSING and CLOSED sockets so the set cannot grow without bound', () => {
    const live = sock(WS_OPEN);
    const closing = sock(WS_CLOSING);
    const closed = sock(WS_CLOSED);
    const clients = new Set<SubscriberSocket>([live, closing, closed]);

    const result = fanOutToSockets(clients, 'chunk');

    expect(result).toEqual({ sent: 1, pruned: 2 });
    expect([...clients]).toEqual([live]);
    expect(closing.send).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });

  // A socket mid-handshake is not dead. Evicting it would unsubscribe a device
  // during its own connect, leaving a permanently blank terminal until reload.
  it('never prunes a CONNECTING socket', () => {
    const connecting = sock(WS_CONNECTING);
    const clients = new Set<SubscriberSocket>([connecting]);

    const result = fanOutToSockets(clients, 'chunk');

    expect(result).toEqual({ sent: 0, pruned: 0 });
    expect(clients.has(connecting)).toBe(true);
    expect(connecting.send).not.toHaveBeenCalled();
  });

  // ws can throw on a socket that closed between the readyState check and the
  // write. Left unhandled it would throw on every chunk forever AND abort the
  // loop, starving every subscriber after it in iteration order.
  it('prunes a socket whose send throws, and still delivers to the rest', () => {
    const wedged = sock(WS_OPEN);
    wedged.send.mockImplementation(() => {
      throw new Error('WebSocket is not open');
    });
    const healthy = sock(WS_OPEN);
    const clients = new Set<SubscriberSocket>([wedged, healthy]);

    const result = fanOutToSockets(clients, 'chunk');

    expect(healthy.send).toHaveBeenCalledWith('chunk');
    expect(result).toEqual({ sent: 1, pruned: 1 });
    expect([...clients]).toEqual([healthy]);
  });

  it('is a no-op on an empty set', () => {
    const clients = new Set<SubscriberSocket>();
    expect(fanOutToSockets(clients, 'chunk')).toEqual({ sent: 0, pruned: 0 });
  });

  it('serialises once and hands the identical payload to each subscriber', () => {
    const a = sock(WS_OPEN);
    const b = sock(WS_OPEN);
    fanOutToSockets(new Set<SubscriberSocket>([a, b]), 'payload');
    expect(a.send.mock.calls[0][0]).toBe(b.send.mock.calls[0][0]);
  });
});
