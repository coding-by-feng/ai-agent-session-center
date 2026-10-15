// scripts/mobile-test-mac.ts — a test-only "Mac" for pairing the Android app on an emulator
// (AASC-17, RELEASE 13). Usage: mobile/README.md "Pairing on an emulator".
// NOT an AASC server: no hook installer, no hook queue, no database, no terminals.
// It mounts the REAL phone pairing routes (server/mobile/mobileRouter.ts + deviceAuth.ts)
// on an in-memory device store, plus a stand-in Mac page, API and WebSocket that need the
// session cookie. Desktop actions (make a pairing code, Allow, revoke) are harness calls
// from this Mac only, with a secret header. Listens on 127.0.0.1:3439 unless MAC_LISTEN_HOST / MAC_PORT
// say otherwise. HARNESS_UI_DIR=<a built page> serves that page (index.html + assets/) as the Mac page
// instead of the stand-in: the phone harness's build answers /api and the WebSocket in-page, so the
// paired app shows the real phone UI on fake data (AASC-48).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createDeviceAuth, type MobileDeviceRecord, type MobileDeviceStore } from '../server/mobile/deviceAuth.js';
import { createMobileRouter } from '../server/mobile/mobileRouter.js';

const PORT = Number(process.env.MAC_PORT ?? 3439);
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('MAC_PORT must be a port number');
// The emulator reaches 127.0.0.1 as 10.0.2.2. The iPhone simulator shares the Mac's network, so it needs
// the Mac's LAN address: MAC_LISTEN_HOST=<that address> MAC_PAIRING_LAN=<that address> (reachable on the
// LAN while it runs; pairing still needs a code from the secret-guarded desktop route).
const LISTEN_HOST = process.env.MAC_LISTEN_HOST ?? '127.0.0.1';
const PAIRING_LAN = process.env.MAC_PAIRING_LAN ?? '10.0.2.2';
const SECRET = process.env.HARNESS_SECRET ?? '';
if (SECRET.length < 16) throw new Error('HARNESS_SECRET missing');
const UI_DIR = process.env.HARNESS_UI_DIR ? path.resolve(process.env.HARNESS_UI_DIR) : null;
if (UI_DIR && !fs.existsSync(path.join(UI_DIR, 'index.html'))) throw new Error('HARNESS_UI_DIR has no index.html');

const rows = new Map<string, MobileDeviceRecord>();
const store: MobileDeviceStore = {
  insert: (rec) => { rows.set(rec.id, { ...rec }); },
  get: (id) => (rows.has(id) ? { ...rows.get(id)! } : null),
  update: (id, patch) => { const r = rows.get(id); if (r) rows.set(id, { ...r, ...patch }); },
  listLive: () => [...rows.values()].filter((r) => r.status !== 'revoked').map((r) => ({ ...r })),
  remove: (id) => { rows.delete(id); },
};

const sessions = new Map<string, string>(); // token -> deviceId
const log = (o: Record<string, unknown>) => console.log(JSON.stringify({ t: new Date().toISOString().slice(11, 19), ...o }));

const deviceAuth = createDeviceAuth({
  store,
  onRevoked: (device) => {
    for (const [tok, id] of sessions) if (id === device.id) sessions.delete(tok);
    log({ event: 'revoked', device: device.label });
  },
});

const cookieToken = (cookie: string | undefined) => /(?:^|;\s*)auth_token=([^;]+)/.exec(cookie ?? '')?.[1] ?? null;
const bearer = (h: string | undefined) => (h?.startsWith('Bearer ') ? h.slice(7) : null);
const authed = (req: http.IncomingMessage) => {
  const tok = cookieToken(req.headers.cookie) ?? bearer(req.headers.authorization);
  return tok !== null && sessions.has(tok);
};

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  log({
    req: `${req.method} ${req.path}`, host: req.headers.host, sfs: req.headers['sec-fetch-site'] ?? null,
    cookie: cookieToken(req.headers.cookie) !== null, bearer: bearer(req.headers.authorization) !== null,
  });
  next();
});

app.use('/api/mobile', createMobileRouter({
  deviceAuth,
  isPasswordEnabled: () => true,
  pairingOffered: () => true,
  requireSession: (req, res, next) => (req.headers['x-harness'] === SECRET ? next() : res.status(401).json({ error: 'Unauthorized' })),
  createSessionToken: (deviceId) => {
    const tok = randomBytes(24).toString('base64url');
    sessions.set(tok, deviceId);
    return tok;
  },
  sessionTtlSeconds: 3600,
  pairingTarget: () => ({ name: 'Emu-Mac', port: PORT, lan: PAIRING_LAN, tailnet: null }),
  rateLimit: { check: () => 0, record: () => undefined, clear: () => undefined },
}));

app.get('/api/auth/status', (req, res) => res.json({ passwordRequired: true, authenticated: authed(req) }));
app.get('/api/sessions', (req, res) => {
  if (!authed(req)) { res.status(401).json({ error: 'Unauthorized' }); return; }
  res.json({ 'sess-1': { sessionId: 'sess-1', title: 'Fix the failing build', status: 'approval', remoteVisible: true } });
});
if (UI_DIR) {
  // The built page: hashed assets as they are, index.html never cached (a rebuilt bundle shows on the
  // next load) and as the fallback for any other GET outside /api, like the real server's SPA routes.
  const sendIndex = (res: express.Response) => res.set('Cache-Control', 'no-store').sendFile(path.join(UI_DIR, 'index.html'));
  app.use(express.static(UI_DIR, { index: false }));
  app.use((req, res, next) => (req.method === 'GET' && !req.path.startsWith('/api/') ? sendIndex(res) : next()));
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width"><title>Emu-Mac</title>
<h1>Mac page</h1><p id=api>api: …</p><p id=ws>ws: …</p>
<script>
fetch('/api/sessions').then(r => r.json().then(b => { document.getElementById('api').textContent = 'api: ' + r.status + ' ' + Object.keys(b).join(','); }));
const s = new WebSocket('ws://' + location.host + '/ws'); s.onmessage = (e) => { document.getElementById('ws').textContent = 'ws: ' + e.data; };
</script>`);
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (sock, req) => {
  const ok = authed(req);
  log({ ws: ok ? 'authenticated' : 'refused' });
  sock.send(ok ? 'authenticated' : 'refused');
  if (!ok) sock.close();
});
server.listen(PORT, LISTEN_HOST, () => log({ listening: `${LISTEN_HOST}:${PORT}` }));
// The desktop routes answer this Mac over loopback only (mobileRouter's local gate), so harness calls
// keep a 127.0.0.1 listener when the phone side listens elsewhere.
if (LISTEN_HOST !== '127.0.0.1') http.createServer(app).listen(PORT, '127.0.0.1', () => log({ listening: `127.0.0.1:${PORT}` }));
