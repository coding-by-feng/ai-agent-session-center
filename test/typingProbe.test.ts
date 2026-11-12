import { describe, it, expect, vi, beforeEach } from 'vitest';
import type WebSocket from 'ws';
import { PROBE_EXPIRE_MS, flushOutputProbe, forgetProbe, noteInputProbe } from '../server/typingProbe.js';

function fakeSocket(readyState = 1) {
  return { readyState, send: vi.fn() } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

describe('server typing probe', () => {
  beforeEach(() => forgetProbe('t1'));

  it('replies to the probing socket on the next output', () => {
    const ws = fakeSocket();
    noteInputProbe('t1', ws, 7, 100);
    flushOutputProbe('t1', 130);
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({ type: 'terminal_probe', terminalId: 't1', id: 7, serverMs: 30 });
    flushOutputProbe('t1', 140);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('ignores a bad probe id', () => {
    const ws = fakeSocket();
    noteInputProbe('t1', ws, 'x', 0);
    noteInputProbe('t1', ws, -1, 0);
    flushOutputProbe('t1', 1);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('drops a stale probe and a closed socket', () => {
    const ws = fakeSocket();
    noteInputProbe('t1', ws, 1, 0);
    flushOutputProbe('t1', PROBE_EXPIRE_MS + 1);
    const closed = fakeSocket(3);
    noteInputProbe('t1', closed, 2, 0);
    flushOutputProbe('t1', 1);
    expect(ws.send).not.toHaveBeenCalled();
    expect(closed.send).not.toHaveBeenCalled();
  });
});
