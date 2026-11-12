// clientUi.test.ts — what a Client edition serves from its own bundle and what still reaches the remote. No Electron,
// no network: the handler takes its reader and its forwarder, and the real Request/Response classes do the rest.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CLIENT_HOME_URL, FORWARDED_CSP, HEADER_GUARD_PATH, HEADER_GUARD_SCRIPT, UI_SECURITY_HEADERS, createHomeHandler, createUiHandler,
  forwardedHeaders, isClientHomeSenderUrl, isOwnDownload, isServerPath, uiContentType, uiFileFor, withHeaderGuard,
} from '../electron/remote/clientUi.js';

const ROOT = path.resolve('/app/dist/client');
const ORIGIN = 'http://192.168.1.20:3334';

function handler(files: Record<string, string> = {}) {
  const forward = vi.fn(async (_request: Request) => new Response('from the remote', { status: 200 }));
  const read = vi.fn(async (file: string) => {
    const hit = files[path.relative(ROOT, file)];
    if (hit === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return Buffer.from(hit);
  });
  return { run: createUiHandler({ origin: () => ORIGIN, root: ROOT, read, forward }), forward, read };
}
const INDEX = { 'index.html': '<title>BUNDLED</title>' };

describe('which paths belong to the remote', () => {
  it.each(['/api', '/api/', '/api/sessions', '/mcp', '/mcp/x', '/ws'])('%s goes to the server', (p) => {
    expect(isServerPath(p)).toBe(true);
  });
  it.each(['/', '/history', '/assets/app.js', '/apifoo', '/mcpx', '/wsx', '/ws/x', '/favicon.svg'])('%s is the UI', (p) => {
    expect(isServerPath(p)).toBe(false);
  });
});

describe('a path inside the bundle', () => {
  it('maps the root to index.html and a file to itself', () => {
    expect(uiFileFor(ROOT, '/')).toBe(path.join(ROOT, 'index.html'));
    expect(uiFileFor(ROOT, '/assets/app.js')).toBe(path.join(ROOT, 'assets/app.js'));
    expect(uiFileFor(ROOT, '/a%20b.png')).toBe(path.join(ROOT, 'a b.png'));
  });

  it.each([
    '/../secret', '/..%2fsecret', '/%2e%2e/secret', '/%2e%2e%2fsecret', '/assets/../../secret',
    '/..%5csecret', '/a%00b', '/%E0%A4%A', '/assets/%2e%2e%2f%2e%2e%2fsecret',
  ])('refuses %s', (p) => {
    expect(uiFileFor(ROOT, p)).toBeNull();
  });
});

describe('content types', () => {
  it.each([
    ['a.js', 'text/javascript'], ['a.mjs', 'text/javascript'], ['a.css', 'text/css'], ['a.html', 'text/html'],
    ['a.svg', 'image/svg+xml'], ['a.png', 'image/png'], ['a.wasm', 'application/wasm'], ['a.ttf', 'font/ttf'],
    ['a.bcmap', 'application/octet-stream'], ['noext', 'application/octet-stream'], ['A.JS', 'text/javascript'],
  ])('%s is %s', (file, type) => {
    expect(uiContentType(file).split(';')[0]).toBe(type);
  });
});

describe('the bundled UI', () => {
  it('serves the page from the bundle and never asks the remote', async () => {
    const { run, forward } = handler(INDEX);
    const res = await run(new Request(`${ORIGIN}/`));
    expect(await res.text()).toContain('<title>BUNDLED</title>');
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(forward).not.toHaveBeenCalled();
  });

  it('falls back to index.html for an app route, as the server does', async () => {
    const { run, forward } = handler(INDEX);
    expect(await (await run(new Request(`${ORIGIN}/history`))).text()).toContain('BUNDLED');
    expect(forward).not.toHaveBeenCalled();
  });

  it('serves a file with its own type', async () => {
    const { run } = handler({ ...INDEX, 'assets/app.js': 'x=1' });
    const res = await run(new Request(`${ORIGIN}/assets/app.js`));
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await res.text()).toBe('x=1');
  });

  it('never reads outside the bundle, however the path is spelled', async () => {
    const { run, read } = handler(INDEX);
    for (const p of ['/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/assets/..%2f..%2f..%2fetc%2fpasswd']) {
      const res = await run(new Request(`${ORIGIN}${p}`));
      expect(await res.text()).toContain('BUNDLED');
    }
    for (const [file] of read.mock.calls) expect(String(file).startsWith(ROOT + path.sep)).toBe(true);
  });

  it('answers HEAD with no body', async () => {
    const { run } = handler(INDEX);
    const res = await run(new Request(`${ORIGIN}/`, { method: 'HEAD' }));
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(await res.text()).toBe('');
  });

  it('sends the security headers the server would have sent', async () => {
    const { run } = handler(INDEX);
    const res = await run(new Request(`${ORIGIN}/`));
    for (const [name, value] of Object.entries(UI_SECURITY_HEADERS)) expect(res.headers.get(name)).toBe(value);
  });

  it('says so plainly when the install has no UI', async () => {
    const { run } = handler({});
    expect((await run(new Request(`${ORIGIN}/`))).status).toBe(500);
  });

  // The bundled page takes the place of one the server would have served, so it must not lose its protection.
  it('matches the headers in server/index.ts, or this copy has drifted', () => {
    const source = readFileSync('server/index.ts', 'utf8');
    const block = source.slice(source.indexOf('// -- Security headers --'), source.indexOf('// -- Central sessions'));
    const found = new Map<string, string>();
    for (const m of block.matchAll(/res\.setHeader\(\s*'([^']+)',\s*"([^"]+)"|res\.setHeader\(\s*'([^']+)',\s*'([^']+)'/g)) {
      found.set((m[1] ?? m[3]).toLowerCase(), m[2] ?? m[4]);
    }
    found.delete('strict-transport-security');
    expect(found.size).toBeGreaterThanOrEqual(6);
    expect(Object.fromEntries(Object.entries(UI_SECURITY_HEADERS).map(([k, v]) => [k.toLowerCase(), v])))
      .toEqual(Object.fromEntries(found));
  });
});

// Electron's protocol.handle rebuilds every request's headers and throws on a non-ASCII value, so that request fails
// before any handler runs. The dashboard's device name is "Mac · Chrome" on every request.
describe('the header guard', () => {
  type Fetch = (input: unknown, init?: { headers?: HeadersInit; method?: string }) => Promise<string>;
  function guarded() {
    const seen: Array<{ input: unknown; init?: { headers?: HeadersInit } }> = [];
    const window = {
      fetch: (input: unknown, init?: { headers?: HeadersInit }) => {
        seen.push({ input, init });
        return Promise.resolve('sent');
      },
    } as { fetch: Fetch };
    new Function('window', 'Headers', 'Request', HEADER_GUARD_SCRIPT)(window, Headers, Request);
    return { fetch: window.fetch, seen };
  }
  const sentHeaders = (entry: { init?: { headers?: HeadersInit } }) => new Headers(entry.init?.headers);

  it('makes a device name with a middle dot safe to send', async () => {
    const { fetch, seen } = guarded();
    await fetch('/api/x', { headers: { 'x-aasc-client-label': 'Mac · Chrome', 'x-other': 'plain' } });
    expect(sentHeaders(seen[0]).get('x-aasc-client-label')).toBe('Mac - Chrome');
    expect(sentHeaders(seen[0]).get('x-other')).toBe('plain');
  });

  it('handles a Headers object and a Request', async () => {
    const { fetch, seen } = guarded();
    await fetch('/api/x', { headers: new Headers({ 'x-a': 'café' }) });
    await fetch(new Request('http://h/api/y', { headers: { 'x-a': 'naïve name' } }));
    expect(sentHeaders(seen[0]).get('x-a')).toBe('caf-');
    expect(sentHeaders(seen[1]).get('x-a')).toBe('na-ve name');
  });

  it('leaves a clean request exactly as it was', async () => {
    const { fetch, seen } = guarded();
    const init = { method: 'POST', headers: { 'x-a': 'plain' } };
    await fetch('/api/x', init);
    await fetch('/api/y');
    expect(seen[0].init).toBe(init);
    expect(seen[1].init).toBeUndefined();
  });

  it('keeps the rest of the request', async () => {
    const { fetch, seen } = guarded();
    await fetch('/api/x', { method: 'POST', headers: { 'x-a': 'é' } });
    expect((seen[0].init as { method?: string }).method).toBe('POST');
  });

  it('fails like fetch on a value no browser can send', async () => {
    const { fetch, seen } = guarded();
    await expect(fetch('/api/x', { headers: { 'x-a': '中' } as HeadersInit })).rejects.toThrow(TypeError);
    expect(seen).toHaveLength(0);
  });

  it('runs before the dashboard, whose bundle wraps fetch afterwards', () => {
    const page = withHeaderGuard('<html><head><meta charset="UTF-8" /><title>x</title><script type="module" src="/assets/a.js"></script></head></html>');
    expect(page.indexOf(HEADER_GUARD_PATH)).toBeGreaterThan(-1);
    expect(page.indexOf(HEADER_GUARD_PATH)).toBeLessThan(page.indexOf('/assets/a.js'));
    expect(page).toContain(`<script src="${HEADER_GUARD_PATH}"></script>`);
  });

  it('is served from the bundle, on an address the CSP allows and the server never sees', async () => {
    const { run, forward } = handler(INDEX);
    const res = await run(new Request(`${ORIGIN}${HEADER_GUARD_PATH}`));
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await res.text()).toBe(HEADER_GUARD_SCRIPT);
    expect(forward).not.toHaveBeenCalled();
    expect(HEADER_GUARD_PATH.startsWith('/')).toBe(true);
    expect(isServerPath(HEADER_GUARD_PATH)).toBe(false);
  });

  it('goes into every page the bundle serves, app routes too', async () => {
    const { run } = handler({ 'index.html': '<html><head></head><body></body></html>' });
    for (const route of ['/', '/history', '/session/abc']) {
      expect(await (await run(new Request(`${ORIGIN}${route}`))).text()).toContain(HEADER_GUARD_PATH);
    }
  });

  it('leaves the bundle\'s other files alone', async () => {
    const { run } = handler({ ...INDEX, 'assets/app.js': '<head>' });
    expect(await (await run(new Request(`${ORIGIN}/assets/app.js`))).text()).toBe('<head>');
  });
});

describe('what still reaches the remote', () => {
  it('forwards an API call', async () => {
    const { run, forward } = handler(INDEX);
    const res = await run(new Request(`${ORIGIN}/api/sessions`));
    expect(await res.text()).toBe('from the remote');
    expect(new URL(forward.mock.calls[0][0].url).pathname).toBe('/api/sessions');
  });

  // Passing through the main process drops Origin, which turns Sec-Fetch-Site from same-origin into none.
  it('states the page\'s origin, replacing whatever was there', async () => {
    const { run, forward } = handler(INDEX);
    await run(new Request(`${ORIGIN}/api/echo`, { headers: { origin: 'http://evil.example' } }));
    expect(forward.mock.calls[0][0].headers.get('origin')).toBe(ORIGIN);
  });

  it('keeps the other headers and the body of a write', async () => {
    const { run, forward } = handler(INDEX);
    await run(new Request(`${ORIGIN}/api/echo`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-client-id': 'c1' }, body: '{"a":1}',
    }));
    const sent = forward.mock.calls[0][0];
    expect(sent.method).toBe('POST');
    expect(sent.headers.get('x-client-id')).toBe('c1');
    expect(await sent.text()).toBe('{"a":1}');
  });

  // A redirect followed in the main process skips the page's CSP and the window's will-redirect policy.
  it('fails on a redirect instead of following it', async () => {
    const { run, forward } = handler(INDEX);
    await run(new Request(`${ORIGIN}/api/x`));
    expect(forward.mock.calls[0][0].redirect).toBe('error');
  });

  it('sends a write to a page path to the server, which answers for it', async () => {
    const { run, forward, read } = handler(INDEX);
    await run(new Request(`${ORIGIN}/history`, { method: 'POST', body: 'x' }));
    expect(forward).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST', 'DELETE'])('refuses %s to any other address and never forwards it', async (method) => {
    const { run, forward } = handler(INDEX);
    const res = await run(new Request('http://localhost:3333/api/terminals', { method }));
    expect(res.type).toBe('error');
    expect(forward).not.toHaveBeenCalled();
  });

  it('treats a remote on the default port as itself', async () => {
    const forward = vi.fn(async () => new Response('remote'));
    const run = createUiHandler({ origin: () => 'http://192.168.1.20:80', root: ROOT, read: async () => Buffer.from('ui'), forward });
    expect(await (await run(new Request('http://192.168.1.20/'))).text()).toMatch(/ui$/);
    expect(forward).not.toHaveBeenCalled();
  });

  it('never lets a forwarded response run as a page', async () => {
    const headers = new Headers({ 'Content-Security-Policy': "default-src *", 'Content-Type': 'text/html' });
    headers.append('Set-Cookie', 'a=1');
    headers.append('Set-Cookie', 'b=2');
    const forward = vi.fn(async () => new Response('<script>x</script>', { status: 201, headers }));
    const run = createUiHandler({ origin: () => ORIGIN, root: ROOT, read: async () => Buffer.from('ui'), forward });
    const res = await run(new Request(`${ORIGIN}/api/x`));
    expect(res.headers.get('content-security-policy')).toBe(FORWARDED_CSP);
    expect(res.status).toBe(201);
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await res.text()).toBe('<script>x</script>');
  });

  it('passes an empty answer through', async () => {
    const forward = vi.fn(async () => new Response(null, { status: 204 }));
    const run = createUiHandler({ origin: () => ORIGIN, root: ROOT, read: async () => Buffer.from('ui'), forward });
    expect((await run(new Request(`${ORIGIN}/api/x`, { method: 'DELETE' }))).status).toBe(204);
  });

  it('follows the remote to a new address', async () => {
    let origin = ORIGIN;
    const forward = vi.fn(async () => new Response('remote'));
    const run = createUiHandler({ origin: () => origin, root: ROOT, read: async () => Buffer.from('ui'), forward });
    origin = 'http://100.64.0.20:3334';
    expect(await (await run(new Request('http://100.64.0.20:3334/'))).text()).toMatch(/ui$/);
    expect((await run(new Request(`${ORIGIN}/`))).type).toBe('error');
    expect(forward).not.toHaveBeenCalled();
  });

  it('forwardedHeaders leaves the original alone', () => {
    const original = new Headers({ 'x-a': '1' });
    const next = forwardedHeaders(original, ORIGIN);
    expect(original.get('origin')).toBeNull();
    expect(next.get('origin')).toBe(ORIGIN);
    expect(next.get('x-a')).toBe('1');
  });
});

describe('a forwarded response is only ever data', () => {
  const answer = (headers: HeadersInit, forward = vi.fn(async (_request: Request) => new Response(new Uint8Array([1]), { headers }))) =>
    createUiHandler({ origin: () => ORIGIN, root: ROOT, read: async () => Buffer.from('ui'), forward })(new Request(`${ORIGIN}/api/x`));

  it.each([
    'text/html', 'text/html; charset=utf-8', 'TEXT/HTML', ' text/html', 'application/xhtml+xml', 'text/css',
    'text/javascript', 'application/javascript', 'application/x-javascript', 'application/ecmascript',
    'text/javascript1.5', 'text/x-ecmascript', 'text/jscript', 'text/livescript', 'application/wasm',
    // A browser reads the last type it can parse, so a safe one in front must not hide this.
    'text/plain, text/html',
  ])('turns %s into plain text', async (type) => {
    expect((await answer({ 'Content-Type': type })).headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it.each([
    'application/json', 'image/png', 'image/svg+xml', 'application/pdf', 'video/mp4', 'audio/mpeg', 'font/woff2',
    'text/plain; charset=utf-8', 'application/octet-stream', 'application/zip',
  ])('leaves %s alone', async (type) => {
    expect((await answer({ 'Content-Type': type })).headers.get('content-type')).toBe(type);
  });

  it('adds no type to an answer without one', async () => {
    expect((await answer({})).headers.get('content-type')).toBeNull();
  });

  it('can\'t be sniffed into something else or put in a frame, whatever the remote sent', async () => {
    const res = await answer({ 'X-Content-Type-Options': 'off', 'X-Frame-Options': 'ALLOWALL' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  // Remove has nothing to wipe that was never written, and Full and Lite's Remove stays as it is.
  it('is never kept in the disk cache', async () => {
    const forward = vi.fn(async (_request: Request) => new Response('x', { headers: { 'Cache-Control': 'max-age=3600' } }));
    await answer({}, forward);
    expect(forward.mock.calls[0][0].cache).toBe('no-store');
  });
});

describe('which downloads a dashboard may start', () => {
  it.each([
    `${ORIGIN}/api/files/stream?path=a.pdf`, // The PDF toolbar's Download is a real link, not a blob.
    `blob:${ORIGIN}/0f1e2d3c`,
  ])('allows %s', (url) => {
    expect(isOwnDownload(url, ORIGIN)).toBe(true);
  });

  it.each([
    'https://evil.example/x.dmg', 'http://localhost:3333/x', 'http://192.168.1.20:9999/x', 'blob:https://evil.example/0f1e',
    'data:text/plain,x', 'file:///etc/passwd', 'not a url', '',
  ])('refuses %s', (url) => {
    expect(isOwnDownload(url, ORIGIN)).toBe(false);
  });

  it('counts a default port as the same address', () => {
    expect(isOwnDownload('http://192.168.1.20/a.pdf', 'http://192.168.1.20:80')).toBe(true);
  });
});

describe('a page opened while the remote doesn\'t answer', () => {
  const offlineHandler = (reachable: () => Promise<boolean>) => {
    const { run: _unused, forward, read } = handler({ ...INDEX, 'assets/app.js': 'code' });
    return { run: createUiHandler({ origin: () => ORIGIN, root: ROOT, read, forward, reachable }), forward };
  };

  it.each(['/', '/history', '/?popout=queue'])('says so at %s, rather than a password form that can\'t succeed', async (route) => {
    const { run, forward } = offlineHandler(async () => false);
    const res = await run(new Request(`${ORIGIN}${route}`));
    const html = await res.text();
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('isn’t answering');
    expect(html).not.toContain('BUNDLED');
    expect(forward).not.toHaveBeenCalled();
  });

  it('tries again by itself, with nothing the page\'s CSP would refuse', async () => {
    const { run } = offlineHandler(async () => false);
    const res = await run(new Request(`${ORIGIN}/`));
    const html = await res.text();
    expect(res.headers.get('content-security-policy')).toBe(UI_SECURITY_HEADERS['Content-Security-Policy']);
    expect(html).toMatch(/<meta http-equiv="refresh" content="\d+">/);
    expect(html).not.toContain('<script');
  });

  it('treats a failed probe as no answer', async () => {
    const { run } = offlineHandler(async () => { throw new Error('boom'); });
    expect((await run(new Request(`${ORIGIN}/`))).status).toBe(503);
  });

  it('serves the page once the remote answers', async () => {
    const { run } = offlineHandler(async () => true);
    const res = await run(new Request(`${ORIGIN}/`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('BUNDLED');
  });

  it('asks only for the page: its files come from the bundle either way', async () => {
    const reachable = vi.fn(async () => false);
    const { run } = offlineHandler(reachable);
    const res = await run(new Request(`${ORIGIN}/assets/app.js`));
    expect(await res.text()).toBe('code');
    expect(reachable).not.toHaveBeenCalled();
  });
});

describe('the home page', () => {
  const HOME = path.resolve('/app/dist/client-home');
  const home = (files: Record<string, string>) => createHomeHandler({
    root: HOME,
    read: async (file) => {
      const hit = files[path.relative(HOME, file)];
      if (hit === undefined) throw new Error('ENOENT');
      return Buffer.from(hit);
    },
  });

  it('is the only page at its address', async () => {
    const run = home({ 'client-home.html': 'HOME', 'assets/a.js': 'x' });
    expect(await (await run(new Request(CLIENT_HOME_URL))).text()).toBe('HOME');
    expect(await (await run(new Request(`${CLIENT_HOME_URL}?start=1`))).text()).toBe('HOME');
    expect(await (await run(new Request(`${CLIENT_HOME_URL}assets/a.js`))).text()).toBe('x');
  });

  it('allows no connection anywhere: it only talks to the main process', async () => {
    const res = await home({ 'client-home.html': 'HOME' })(new Request(CLIENT_HOME_URL));
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain("frame-src 'none'");
  });

  it('answers another host of the scheme with nothing', async () => {
    const run = home({ 'client-home.html': 'HOME' });
    expect((await run(new Request('aasc-client://other/'))).status).toBe(404);
  });
});

describe('who may drive remote computers in a Client', () => {
  it.each(['aasc-client://home/', 'aasc-client://home/?start=1', 'aasc-client://home/index.html'])('%s may', (url) => {
    expect(isClientHomeSenderUrl(url)).toBe(true);
  });
  it.each([
    'aasc-client://other/', 'aasc-client://home.evil/', 'http://home/', 'https://aasc.work/', 'file:///home/',
    'http://localhost:3333/', 'http://192.168.1.20:3334/', 'aasc-client:', '', 'not a url',
  ])('%s may not', (url) => {
    expect(isClientHomeSenderUrl(url)).toBe(false);
  });
});
