// test/wsServerOptions.test.ts — the dashboard's WebSocket compresses what is big.
//
// Nov 7 2026: a phone on weak Wi-Fi sat on "Loading sessions…". On connect the Mac sends every
// session (1.17 MB that night) and then a whole session per hook update (Tavonu's was 200 KB),
// with three sessions working: about 4.7 MB in 98 s. The phone fell behind, its pongs queued
// behind megabytes, the heartbeat dropped it after 30 s, and it reconnected into the same
// snapshot. permessage-deflate makes that JSON about a quarter of the size on the wire.
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { WS_SERVER_OPTIONS } from '../server/wsServerOptions.js';

let http: Server | null = null;
let wss: WebSocketServer | null = null;

afterEach(async () => {
  wss?.clients.forEach((c) => c.terminate());
  await new Promise<void>((r) => (wss ? wss.close(() => r()) : r()));
  await new Promise<void>((r) => (http ? http.close(() => r()) : r()));
  http = null;
  wss = null;
});

/** A server built the way server/index.ts builds it, sending `payload` to each socket on connect. */
async function serve(payload: string): Promise<string> {
  http = createServer();
  wss = new WebSocketServer({ server: http, ...WS_SERVER_OPTIONS });
  wss.on('connection', (ws) => {
    ws.send(payload);
    ws.on('message', (m) => ws.send(m.toString()));
  });
  await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
  return `ws://127.0.0.1:${(http.address() as AddressInfo).port}/`;
}

/** A session list shaped like the real one: prompt text, tool calls and replies, repeated per session. */
function snapshotLike(sessions: number): string {
  const all: Record<string, unknown> = {};
  for (let i = 0; i < sessions; i += 1) {
    all[`session-${i}`] = {
      sessionId: `session-${i}`,
      status: i % 3 ? 'idle' : 'working',
      promptHistory: Array.from({ length: 40 }, (_, n) => ({ text: `<task-notification> <task-id>a${i}${n}</task-id> Fix the queue so it sends prompt ${n} for session ${i} once the agents finish.`, timestamp: 1_794_000_000_000 + n })),
      toolLog: Array.from({ length: 120 }, (_, n) => ({ tool: n % 2 ? 'Bash' : 'Read', input: `npx vitest run src/lib/chat/file-${n}.test.ts`, timestamp: 1_794_000_000_000 + n })),
    };
  }
  return JSON.stringify({ type: 'snapshot', sessions: all });
}

describe('WS_SERVER_OPTIONS', () => {
  it('negotiates permessage-deflate with a client that offers it', async () => {
    const url = await serve('hello');
    const client = new WebSocket(url);
    await new Promise((r) => client.once('open', r));
    expect(client.extensions).toContain('permessage-deflate');
    client.close();
  });

  it('sends a large snapshot in a fraction of its bytes, and it arrives whole', async () => {
    const payload = snapshotLike(36);
    const url = await serve(payload);
    const client = new WebSocket(url);
    const received = await new Promise<string>((r) => client.once('message', (m) => r(m.toString())));
    const onTheWire = (client as unknown as { _socket: { bytesRead: number } })._socket.bytesRead;
    expect(received).toBe(payload);
    expect(onTheWire).toBeLessThan(payload.length / 3);
    client.close();
  });

  it('still talks to a client that does not offer compression', async () => {
    const payload = snapshotLike(2);
    const url = await serve(payload);
    const client = new WebSocket(url, { perMessageDeflate: false });
    const received = await new Promise<string>((r) => client.once('message', (m) => r(m.toString())));
    expect(client.extensions).toBe('');
    expect(received).toBe(payload);
    client.close();
  });

  it('leaves small frames alone (keystrokes, acks) and round-trips them', async () => {
    const url = await serve('{"type":"ready"}');
    const client = new WebSocket(url);
    await new Promise((r) => client.once('message', r));
    const echoed = new Promise<string>((r) => client.once('message', (m) => r(m.toString())));
    client.send('{"type":"terminal_input","data":"l"}');
    expect(await echoed).toBe('{"type":"terminal_input","data":"l"}');
    expect(WS_SERVER_OPTIONS.perMessageDeflate.threshold).toBeGreaterThanOrEqual(1024);
    client.close();
  });

  it('keeps the existing message size cap', () => {
    expect(WS_SERVER_OPTIONS.maxPayload).toBe(512 * 1024);
  });
});
