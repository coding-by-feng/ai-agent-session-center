import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { AddressInfo } from 'net';
import { attach, buildWsUrl, RESTORE_SEQUENCE, type AttachIo, type AttachResult } from '../cli/client/attach.js';
import { watchSocket } from '../cli/client/watchCommand.js';
import { createWatchState } from '../cli/client/watch.js';
import { createServer } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TERMINAL = 'term-1';
const CTRL_RBRACKET = '\x1d';

interface Msg { type: string; [k: string]: unknown }

/**
 * A fake AASC WebSocket on 127.0.0.1 and a random port: never the real app. Like the
 * real server it answers a subscribe with the PTY's geometry and echoes a resize back
 * as terminal_geometry to the resizing socket.
 */
async function fakeServer(opts: { cols?: number; rows?: number; onSubscribe?: (ws: WebSocket) => void } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const port = (wss.address() as AddressInfo).port;
  const received: Msg[] = [];
  let socket: WebSocket | null = null;
  let upgrade: IncomingMessage | null = null;
  let geometry = { cols: opts.cols ?? 100, rows: opts.rows ?? 30 };
  wss.on('connection', (ws, req) => {
    socket = ws;
    upgrade = req;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      received.push(msg);
      if (msg.type === 'terminal_subscribe') {
        if (opts.onSubscribe) { opts.onSubscribe(ws); return; }
        ws.send(JSON.stringify({ type: 'terminal_geometry', terminalId: TERMINAL, ...geometry }));
      }
      if (msg.type === 'terminal_resize') {
        geometry = { cols: msg.cols as number, rows: msg.rows as number };
        ws.send(JSON.stringify({ type: 'terminal_geometry', terminalId: TERMINAL, ...geometry }));
      }
    });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    received,
    get socket() { return socket; },
    get upgrade() { return upgrade; },
    send(msg: Msg) { socket?.send(JSON.stringify(msg)); },
    of(type: string) { return received.filter((m) => m.type === type); },
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
}

type FakeIo = AttachIo & {
  stdinStream: PassThrough & { isTTY: boolean; setRawMode: ReturnType<typeof vi.fn> };
  written: string[];
  setSize(cols: number, rows: number): void;
  fireExit(): void;
};

function fakeIo(cols = 120, rows = 40): FakeIo {
  const stdinStream = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
  const written: string[] = [];
  let size = { cols, rows };
  const resizeCbs = new Set<() => void>();
  const exitCbs = new Set<() => void>();
  return {
    stdin: stdinStream,
    stdinStream,
    stdout: { write: (chunk: string | Uint8Array) => { written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true; } },
    size: () => size,
    onResize: (cb) => { resizeCbs.add(cb); return () => resizeCbs.delete(cb); },
    onExit: (cb) => { exitCbs.add(cb); return () => exitCbs.delete(cb); },
    written,
    setSize: (c, r) => { size = { cols: c, rows: r }; for (const cb of resizeCbs) cb(); },
    fireExit: () => { for (const cb of [...exitCbs]) cb(); },
  };
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(io: FakeIo, serverOpts?: Parameters<typeof fakeServer>[0]) {
  const server = await fakeServer(serverOpts);
  servers.push(server);
  const done: Promise<AttachResult> = attach({
    url: buildWsUrl(server.origin, { clientId: 'aasc-client-1', label: 'aasc on box' }),
    headers: { Authorization: 'Bearer tok_abcdefghijklmnop' },
    terminalId: TERMINAL,
    io,
    escapeWindowMs: 40,
    inputThrottleMs: 0,
    geometryWaitMs: 200,
  });
  await until(() => server.of('terminal_resize').length > 0 && io.stdinStream.setRawMode.mock.calls.length > 0);
  return { server, done };
}

describe('buildWsUrl', () => {
  it('carries clientId, label and role=cli, and maps http to ws', () => {
    const url = new URL(buildWsUrl('http://127.0.0.1:4000', { clientId: 'aasc-x', label: 'aasc on my box' }));
    expect(url.protocol).toBe('ws:');
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('clientId')).toBe('aasc-x');
    expect(url.searchParams.get('label')).toBe('aasc on my box');
    expect(url.searchParams.get('role')).toBe('cli');
    expect(url.searchParams.has('token')).toBe(false);
    expect(buildWsUrl('https://box.example', { clientId: 'a', label: 'b' })).toMatch(/^wss:\/\/box\.example\//);
  });
});

describe('aasc attach', () => {
  it('connects with the bearer header and the identity query, then subscribes and sends its size', async () => {
    const io = fakeIo(120, 40);
    const { server } = await start(io);
    expect(server.upgrade?.headers.authorization).toBe('Bearer tok_abcdefghijklmnop');
    expect(new URL(server.upgrade!.url!, 'http://x').searchParams.get('role')).toBe('cli');
    expect(server.received[0]).toEqual({ type: 'terminal_subscribe', terminalId: TERMINAL });
    expect(server.of('terminal_resize')).toEqual([{ type: 'terminal_resize', terminalId: TERMINAL, cols: 120, rows: 40 }]);
  });

  it('nudges the size when the PTY already has ours, so a TUI redraws', async () => {
    const io = fakeIo(100, 30);
    const { server } = await start(io, { cols: 100, rows: 30 });
    await until(() => server.of('terminal_resize').length >= 2);
    expect(server.of('terminal_resize').map((m) => [m.cols, m.rows])).toEqual([[99, 30], [100, 30]]);
  });

  it('writes terminal_output bytes to stdout', async () => {
    const io = fakeIo();
    const { server } = await start(io);
    server.send({ type: 'terminal_output', terminalId: TERMINAL, data: Buffer.from('hello \x1b[1mworld').toString('base64') });
    await until(() => io.written.join('').includes('hello \x1b[1mworld'));
  });

  it('turns raw mode on and sends stdin bytes as terminal_input', async () => {
    const io = fakeIo();
    const { server } = await start(io);
    expect(io.stdinStream.setRawMode).toHaveBeenCalledWith(true);
    io.stdinStream.write('ls -la\r');
    await until(() => server.of('terminal_input').length > 0);
    expect(server.of('terminal_input')[0]).toEqual({ type: 'terminal_input', terminalId: TERMINAL, data: 'ls -la\r' });
  });

  it('SIGWINCH sends terminal_resize, clamped to the server’s limits', async () => {
    const io = fakeIo();
    const { server } = await start(io);
    io.setSize(132, 43);
    await until(() => server.of('terminal_resize').some((m) => m.cols === 132));
    io.setSize(900, 400);
    await until(() => server.of('terminal_resize').some((m) => m.cols === 500));
    expect(server.of('terminal_resize').at(-1)).toMatchObject({ cols: 500, rows: 200 });
  });

  it('a terminal_geometry from another device sends no resize until our next keystroke', async () => {
    const io = fakeIo(120, 40);
    const { server } = await start(io);
    const before = server.of('terminal_resize').length;
    server.send({ type: 'terminal_geometry', terminalId: TERMINAL, cols: 200, rows: 50 });
    await new Promise((r) => setTimeout(r, 60));
    expect(server.of('terminal_resize')).toHaveLength(before);
    io.stdinStream.write('a');
    await until(() => server.of('terminal_input').length > 0);
    const resizes = server.of('terminal_resize');
    expect(resizes).toHaveLength(before + 1);
    expect(resizes.at(-1)).toMatchObject({ cols: 120, rows: 40 });
    // The size goes out before the keystroke.
    const order = server.received.filter((m) => m.type === 'terminal_resize' || m.type === 'terminal_input').slice(-2).map((m) => m.type);
    expect(order).toEqual(['terminal_resize', 'terminal_input']);
  });

  it('Ctrl-] detaches: terminal_disconnect, the restore sequence, raw mode off, exit 0', async () => {
    const io = fakeIo();
    const { server, done } = await start(io);
    io.stdinStream.write(CTRL_RBRACKET);
    const result = await done;
    expect(result.code).toBe(0);
    await until(() => server.of('terminal_disconnect').length > 0);
    expect(server.of('terminal_disconnect')[0]).toEqual({ type: 'terminal_disconnect', terminalId: TERMINAL });
    expect(server.of('terminal_input')).toEqual([]);
    expect(io.written.join('')).toContain(RESTORE_SEQUENCE);
    expect(io.stdinStream.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('the restore sequence leaves the alt screen, shows the cursor, and turns off mouse and paste modes', () => {
    for (const seq of ['\x1b[?1049l', '\x1b[?25h', '\x1b[?1000l', '\x1b[?1002l', '\x1b[?1003l', '\x1b[?1006l', '\x1b[?2004l', '\x1b[0m']) {
      expect(RESTORE_SEQUENCE).toContain(seq);
    }
  });

  it('Ctrl-] twice sends one literal Ctrl-] and stays attached', async () => {
    const io = fakeIo();
    const { server, done } = await start(io);
    io.stdinStream.write(CTRL_RBRACKET);
    io.stdinStream.write(CTRL_RBRACKET);
    await until(() => server.of('terminal_input').length > 0);
    expect(server.of('terminal_input')).toEqual([{ type: 'terminal_input', terminalId: TERMINAL, data: CTRL_RBRACKET }]);
    await new Promise((r) => setTimeout(r, 80));
    expect(server.of('terminal_disconnect')).toEqual([]);
    io.stdinStream.write(CTRL_RBRACKET);
    await expect(done).resolves.toMatchObject({ code: 0 });
  });

  it('terminal_closed ends the attach cleanly', async () => {
    const io = fakeIo();
    const { server, done } = await start(io);
    server.send({ type: 'terminal_output', terminalId: TERMINAL, data: Buffer.from('bye').toString('base64') });
    server.send({ type: 'terminal_closed', terminalId: TERMINAL, reason: 'exited' });
    const result = await done;
    expect(result).toMatchObject({ code: 0, reason: 'closed' });
    expect(io.written.join('')).toContain(RESTORE_SEQUENCE);
  });

  it('a terminal the server won’t stream is exit 4', async () => {
    const io = fakeIo();
    const server = await fakeServer({
      onSubscribe: (ws) => ws.send(JSON.stringify({ type: 'terminal_closed', terminalId: TERMINAL, reason: 'unavailable' })),
    });
    servers.push(server);
    const result = await attach({
      url: buildWsUrl(server.origin, { clientId: 'c', label: 'l' }), headers: {}, terminalId: TERMINAL, io,
      escapeWindowMs: 40, inputThrottleMs: 0, geometryWaitMs: 200,
    });
    expect(result).toMatchObject({ code: 4, reason: 'unavailable' });
    expect(io.stdinStream.setRawMode).not.toHaveBeenCalledWith(true);
  });

  it('a lost socket restores the terminal and exits 2', async () => {
    const io = fakeIo();
    const { server, done } = await start(io);
    server.socket?.terminate();
    const result = await done;
    expect(result).toMatchObject({ code: 2, reason: 'lost' });
    expect(io.written.join('')).toContain(RESTORE_SEQUENCE);
    expect(io.stdinStream.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('restores the terminal when the process exits mid-attach', async () => {
    const io = fakeIo();
    await start(io);
    io.fireExit();
    expect(io.written.join('')).toContain(RESTORE_SEQUENCE);
    expect(io.stdinStream.setRawMode).toHaveBeenLastCalledWith(false);
  });

  it('splits a huge paste into frames the server accepts', async () => {
    const io = fakeIo();
    const { server } = await start(io);
    const big = 'x'.repeat(200_000);
    io.stdinStream.write(big);
    await until(() => server.of('terminal_input').map((m) => m.data as string).join('').length === big.length);
    for (const m of server.of('terminal_input')) expect((m.data as string).length).toBeLessThanOrEqual(65_536);
  });
});

describe('attach over the tunnel’s Unix socket', () => {
  it('builds a ws+unix URL and attaches through the socket with Host: localhost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aasc-ws-'));
    const sock = join(dir, 's.sock');
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const received: Msg[] = [];
    let host: string | undefined;
    wss.on('connection', (ws, req) => {
      host = req.headers.host;
      expect(new URL(req.url!, 'http://x').searchParams.get('role')).toBe('cli');
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as Msg;
        received.push(msg);
        if (msg.type === 'terminal_subscribe') ws.send(JSON.stringify({ type: 'terminal_geometry', terminalId: TERMINAL, cols: 80, rows: 24 }));
      });
    });
    await new Promise<void>((r) => http.listen(sock, () => r()));
    try {
      const url = buildWsUrl('http://localhost', { clientId: 'aasc-c', label: 'aasc on box' }, sock);
      expect(url.startsWith(`ws+unix://${sock}:/?`)).toBe(true);
      const io = fakeIo();
      const done = attach({ url, headers: { Authorization: 'Bearer t' }, terminalId: TERMINAL, io, escapeWindowMs: 20, inputThrottleMs: 0, geometryWaitMs: 200 });
      await until(() => received.some((m) => m.type === 'terminal_resize'));
      expect(host).toBe('localhost');
      io.stdinStream.write(CTRL_RBRACKET);
      await expect(done).resolves.toMatchObject({ code: 0 });
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => http.close(() => r())));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('attach enters its screen only once raw mode is on', () => {
  it('holds replayed output until then, and writes it after the alternate screen', async () => {
    const io = fakeIo();
    const rawAt: number[] = [];
    io.stdinStream.setRawMode.mockImplementation(() => { rawAt.push(io.written.length); });
    const server = await fakeServer({
      onSubscribe: (ws) => {
        ws.send(JSON.stringify({ type: 'terminal_output', terminalId: TERMINAL, data: Buffer.from('REPLAY').toString('base64') }));
        ws.send(JSON.stringify({ type: 'terminal_geometry', terminalId: TERMINAL, cols: 100, rows: 30 }));
      },
    });
    servers.push(server);
    void attach({
      url: buildWsUrl(server.origin, { clientId: 'c', label: 'l' }), headers: {}, terminalId: TERMINAL, io,
      escapeWindowMs: 40, inputThrottleMs: 0, geometryWaitMs: 200,
    });
    await until(() => io.written.join('').includes('REPLAY'));
    const all = io.written.join('');
    expect(rawAt).toHaveLength(1);
    expect(io.written.slice(0, rawAt[0]).join('')).not.toContain('\x1b[?1049h');
    expect(all.indexOf('\x1b[?1049h')).toBeLessThan(all.indexOf('REPLAY'));
    io.stdinStream.write(CTRL_RBRACKET);
  });

  it('a terminal it never attached to leaves the screen alone', async () => {
    const io = fakeIo();
    const server = await fakeServer({
      onSubscribe: (ws) => ws.send(JSON.stringify({ type: 'terminal_closed', terminalId: TERMINAL, reason: 'unavailable' })),
    });
    servers.push(server);
    await attach({ url: buildWsUrl(server.origin, { clientId: 'c', label: 'l' }), headers: {}, terminalId: TERMINAL, io, geometryWaitMs: 200 });
    expect(io.written.join('')).not.toContain('\x1b[?1049h');
  });
});

describe('watch heartbeat', () => {
  it('ends a socket whose server stops answering pings, so watch can reconnect', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong: false });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as AddressInfo).port;
    try {
      const conn = {
        server: { name: 'vps' }, via: 'tailnet',
        auth: { origin: `http://127.0.0.1:${port}`, bearer: 'b', clientId: 'c', label: 'l' },
      } as unknown as Parameters<typeof watchSocket>[1];
      const ctx = { out: () => {}, err: () => {}, now: () => Date.now(), env: {} } as unknown as Parameters<typeof watchSocket>[0];
      const started = Date.now();
      await watchSocket(ctx, conn, createWatchState(), false, { pingMs: 40 });
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
