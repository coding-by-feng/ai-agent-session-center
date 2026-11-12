// electronEdition.test.ts — how the packaged Lite app knows what it is, stays alone on the shared
// data folder, and refuses to touch a running Full app. No test here can reach a real process:
// isPortFree only binds a throwaway listener of its own, and nothing kills anything.
import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { desktopAppName, parseDesktopEdition } from '../electron/edition.js';
import {
  chooseLitePort, isAascServer, isPortFree, noFreePortMessage, portBusyMessage, portMovedMessage, resolveServerPort,
} from '../electron/portPreflight.js';
import { claimSingleInstance } from '../electron/singleInstance.js';

describe('parseDesktopEdition', () => {
  it('is lite only when the packaged package.json says so', () => {
    expect(parseDesktopEdition('{"name":"x","aascEdition":"lite"}')).toBe('lite');
  });

  it.each(['{"name":"x"}', '{"aascEdition":"LITE"}', 'not json', ''])('reads %j as full', (text) => {
    expect(parseDesktopEdition(text)).toBe('full');
  });

  it('names each edition', () => {
    expect(desktopAppName('full')).toBe('AI Agent Session Center');
    expect(desktopAppName('lite')).toBe('AI Agent Session Center Lite');
  });
});

describe('claimSingleInstance', () => {
  it('claims the lock and brings its window forward on the next launch', () => {
    const on = vi.fn();
    const show = vi.fn();
    expect(claimSingleInstance({ requestSingleInstanceLock: () => true, on }, show)).toBe(true);
    expect(on).toHaveBeenCalledWith('second-instance', show);
  });

  it('reports the second copy, which must exit without starting anything', () => {
    const on = vi.fn();
    expect(claimSingleInstance({ requestSingleInstanceLock: () => false, on }, vi.fn())).toBe(false);
    expect(on).not.toHaveBeenCalled();
  });
});

describe('resolveServerPort', () => {
  it('follows resolvePort: flag, then PORT, then config, then 3333', () => {
    expect(resolveServerPort(['--port', '4001'], { PORT: '4002' }, '{"port":4003}')).toBe(4001);
    expect(resolveServerPort([], { PORT: '4002' }, '{"port":4003}')).toBe(4002);
    expect(resolveServerPort([], {}, '{"port":4003}')).toBe(4003);
    expect(resolveServerPort([], {}, null)).toBe(3333);
  });

  it('falls back to the default on a config it cannot read', () => {
    expect(resolveServerPort([], {}, 'not json')).toBe(3333);
    expect(resolveServerPort([], {}, '{"port":"nope"}')).toBe(3333);
  });
});

describe('isPortFree', () => {
  it('sees a held port as busy, and the same port as free once released', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, resolve));
    const { port } = holder.address() as net.AddressInfo;

    expect(await isPortFree(port)).toBe(false);
    await new Promise((resolve) => holder.close(resolve));
    expect(await isPortFree(port)).toBe(true);
  });

  // macOS lets the server's listener start beside one on 127.0.0.1 alone, and the window's localhost could
  // then reach the other program instead of Lite.
  it('sees a port held on the loopback address alone as busy', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const { port } = holder.address() as net.AddressInfo;

    expect(await isPortFree(port)).toBe(false);
    await new Promise((resolve) => holder.close(resolve));
  });

  it('sees a port held on ::1 alone as busy, where the window\'s localhost may land first', async () => {
    const holder = net.createServer();
    const listening = await new Promise<boolean>((resolve) => {
      holder.once('error', () => resolve(false));
      holder.listen(0, '::1', () => resolve(true));
    });
    if (!listening) return; // This machine has no IPv6 loopback, so nothing can hold it.
    const { port } = holder.address() as net.AddressInfo;

    expect(await isPortFree(port)).toBe(false);
    await new Promise((resolve) => holder.close(resolve));
  });

  it('tells the user what to do, naming the port', () => {
    expect(portBusyMessage(3334)).toMatch(/Port 3334 is in use.*Quit it/);
  });
});

describe('isAascServer', () => {
  async function answering(status: number, body: string): Promise<{ port: number; close: () => Promise<unknown> }> {
    const server = http.createServer((_req, res) => { res.statusCode = status; res.end(body); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { port: (server.address() as net.AddressInfo).port, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  it.each([
    ['no password', '{"passwordRequired":false,"authenticated":true}'],
    ['a password, signed out', '{"passwordRequired":true,"authenticated":false}'],
    ['a login lockout', '{"passwordRequired":true,"authenticated":false,"lockedFor":60}'],
  ])('recognises an AASC server with %s', async (_name, body) => {
    const server = await answering(200, body);
    expect(await isAascServer(server.port)).toBe(true);
    await server.close();
  });

  it.each([
    ['another JSON API', 200, '{"status":"ok"}'],
    ['a web page', 200, '<html></html>'],
    ['JSON with the wrong types', 200, '{"passwordRequired":"yes","authenticated":1}'],
    ['JSON that is not an object', 200, 'null'],
    ['an error status', 500, '{"passwordRequired":true,"authenticated":false}'],
  ])('does not mistake %s for one', async (_name, status, body) => {
    const server = await answering(status, body);
    expect(await isAascServer(server.port)).toBe(false);
    await server.close();
  });

  it('waits for an AASC server that is slow to answer, as a busy older Full can be', async () => {
    const slow = http.createServer((_req, res) => {
      setTimeout(() => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ passwordRequired: true, authenticated: false }));
      }, 2000);
    });
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    const { port } = slow.address() as net.AddressInfo;
    expect(await isAascServer(port)).toBe(true);
    await new Promise((resolve) => slow.close(resolve));
  });

  it('treats a program that accepts the connection and never answers as something else', async () => {
    const silent = net.createServer();
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as net.AddressInfo;
    const sockets = new Set<net.Socket>();
    silent.on('connection', (socket) => sockets.add(socket));
    expect(await isAascServer(port, 100)).toBe(false);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => silent.close(resolve));
  });

  it('treats a port nothing is listening on as something else', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise((resolve) => probe.close(resolve));
    expect(await isAascServer(port)).toBe(false);
  });
});

describe('chooseLitePort', () => {
  const checks = (busy: number[], aasc: number[] = []) => ({
    isPortFree: async (port: number) => !busy.includes(port),
    isAascServer: async (port: number) => aasc.includes(port),
  });

  it('keeps the usual port when it is free', async () => {
    expect(await chooseLitePort(3333, checks([]))).toEqual({ port: 3333 });
  });

  it('moves to the next free port when another program holds it', async () => {
    expect(await chooseLitePort(3333, checks([3333]))).toEqual({ port: 3334 });
    expect(await chooseLitePort(3333, checks([3333, 3334, 3335]))).toEqual({ port: 3336 });
  });

  it('stops when another AASC server holds it: moving would run two servers on one database', async () => {
    const isAascServer = vi.fn(async () => true);
    const choice = await chooseLitePort(3333, { ...checks([3333]), isAascServer });
    expect(choice).toEqual({ stop: portBusyMessage(3333) });
    expect(isAascServer).toHaveBeenCalledWith(3333);
  });

  it('asks who holds only the usual port, not every port it tries', async () => {
    const isAascServer = vi.fn(async () => false);
    await chooseLitePort(3333, { ...checks([3333, 3334]), isAascServer });
    expect(isAascServer).toHaveBeenCalledTimes(1);
  });

  it('tries twenty more ports, then says none is free', async () => {
    const taken = Array.from({ length: 21 }, (_, i) => 3333 + i);
    expect(await chooseLitePort(3333, checks(taken))).toEqual({ stop: noFreePortMessage(3333, 3353) });
    expect(await chooseLitePort(3333, checks(taken.slice(0, -1)))).toEqual({ port: 3353 });
  });

  it('never tries a port above 65535', async () => {
    const isPortFree = vi.fn(async (port: number) => port !== 65535);
    expect(await chooseLitePort(65535, { isPortFree, isAascServer: async () => false }))
      .toEqual({ stop: noFreePortMessage(65535, 65535) });
    expect(isPortFree).toHaveBeenCalledTimes(1);
  });

  it('works against real listeners, and leaves the holder running', async () => {
    const holder = net.createServer();
    const sockets = new Set<net.Socket>();
    holder.on('connection', (socket) => sockets.add(socket)); // Silent, like a program that doesn't speak HTTP.
    await new Promise<void>((resolve) => holder.listen(0, resolve));
    const { port } = holder.address() as net.AddressInfo;

    const choice = await chooseLitePort(port, { isPortFree, isAascServer: (p) => isAascServer(p, 100) });

    expect(choice).toEqual({ port: expect.any(Number) });
    expect((choice as { port: number }).port).toBeGreaterThan(port);
    expect(holder.listening).toBe(true);
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => holder.close(resolve));
  });

  it('says what happened on the loading screen', () => {
    expect(portMovedMessage(3333, 3334)).toBe('Port 3333 is in use, so Lite is using port 3334');
    expect(noFreePortMessage(3333, 3353)).toMatch(/Ports 3333.3353 are all in use/);
  });
});
