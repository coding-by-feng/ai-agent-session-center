// test/alertLevels.test.ts — alert levels on the server (Nov 25 2026): the saved level table (server/alertConfig.ts) and
// the routes (server/alertLevelRouter.ts): the table, a session's level, and the older Mute and Alert routes as levels.
// The router runs on its own with fake session and room stores: nothing here starts a PTY or touches a process.
import { lstatSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { createServer, type Server } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ALERT_CONFIG, legacyFlags, type AlertConfig, type AlertLevel } from '../src/lib/attention.js';
import type { Room } from '../src/types/room.js';
import type { Session } from '../src/types/session.js';
import {
  _resetAlertConfigForTests,
  alertLevelOf,
  alertOutputsOf,
  followedAlertLevel,
  getAlertConfig,
  setAlertConfig,
} from '../server/alertConfig.js';
import { createAlertLevelRouter } from '../server/alertLevelRouter.js';

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

let dir: string;
let file: string;
const saved = process.env.AASC_ALERT_LEVELS_FILE;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aasc-alert-'));
  file = join(dir, 'alert-levels.json');
  process.env.AASC_ALERT_LEVELS_FILE = file;
  _resetAlertConfigForTests();
});
afterEach(() => {
  if (saved === undefined) delete process.env.AASC_ALERT_LEVELS_FILE;
  else process.env.AASC_ALERT_LEVELS_FILE = saved;
  _resetAlertConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

const withNormal = (over: Partial<AlertConfig['levels']['normal']>): AlertConfig => ({
  ...DEFAULT_ALERT_CONFIG,
  levels: { ...DEFAULT_ALERT_CONFIG.levels, normal: { ...DEFAULT_ALERT_CONFIG.levels.normal, ...over } },
});

describe('alert-levels.json', () => {
  it('is the defaults when there is no file, or it is not JSON', () => {
    expect(getAlertConfig()).toEqual(DEFAULT_ALERT_CONFIG);
    writeFileSync(file, 'not json');
    _resetAlertConfigForTests();
    expect(getAlertConfig()).toEqual(DEFAULT_ALERT_CONFIG);
  });

  it('saves privately and reads back what it saved, after a restart too', () => {
    const next = { ...withNormal({ repeatMin: 10 }), defaultLevel: 'quiet' as const };
    setAlertConfig(next);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(next);
    _resetAlertConfigForTests();
    expect(getAlertConfig()).toEqual(next);
  });

  // Nov 25 2026 (security review): the temporary file was `<file>.<pid>.tmp`, a name anyone could guess, opened to
  // follow a link, so a link planted there had the save overwrite whatever it pointed at.
  it('never writes through a link planted where its temporary file could go', () => {
    const target = join(dir, 'precious.txt');
    writeFileSync(target, 'precious');
    symlinkSync(target, `${file}.${process.pid}.tmp`);
    setAlertConfig({ ...DEFAULT_ALERT_CONFIG, defaultLevel: 'quiet' });
    expect(readFileSync(target, 'utf8')).toBe('precious');
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(file, 'utf8')).defaultLevel).toBe('quiet');
  });

  it('resolves a session from its own level, its room, then the default', () => {
    const rooms = [{ id: 'r1', name: 'Ops', sessionIds: ['in-room'], collapsed: false, createdAt: 0, alertLevel: 'urgent' }] as Room[];
    setAlertConfig({ ...DEFAULT_ALERT_CONFIG, defaultLevel: 'quiet' });
    expect(alertLevelOf({ sessionId: 'in-room', alertLevel: 'loud' }, rooms)).toBe('loud');
    expect(alertLevelOf({ sessionId: 'in-room' }, rooms)).toBe('urgent');
    expect(alertLevelOf({ sessionId: 'loose' }, rooms)).toBe('quiet');
    expect(followedAlertLevel('in-room', rooms)).toBe('urgent');
    expect(alertOutputsOf({ sessionId: 'loose' }, rooms).push).toBe(false);
    expect(alertOutputsOf({ sessionId: 'in-room' }, rooms).repeatMin).toBe(5);
  });
});

// ── The routes ────────────────────────────────────────────────────────────────────────────────────

let server: Server;
let base = '';
let sessions: Map<string, Session>;
let rooms: Room[];
/** Older session ids and the current id each now names (sessionStore.getSession follows them the same way). */
let aliases: Map<string, string>;
const setLevel = vi.fn();

function card(id: string, over: Partial<Session> = {}): Session {
  return { sessionId: id, status: 'idle', ...over } as unknown as Session;
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', createAlertLevelRouter({
    getSession: (id) => sessions.get(aliases.get(id) ?? id) ?? null,
    setSessionAlertLevel: (id, level) => {
      setLevel(id, level);
      const s = sessions.get(id);
      if (!s) return null;
      const next = { ...s, ...legacyFlags(level) } as Session;
      if (level) next.alertLevel = level;
      else delete next.alertLevel;
      sessions.set(id, next);
      return next;
    },
    rooms: () => rooms,
    isLocal: (req) => req.get('X-Test-Remote') !== '1',
  }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  sessions = new Map([['s1', card('s1')]]);
  rooms = [];
  aliases = new Map();
  setLevel.mockClear();
});

const put = (path: string, body: unknown, remote = false) =>
  fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(remote ? { 'X-Test-Remote': '1' } : {}) },
    body: JSON.stringify(body),
  });

describe('PUT /sessions/:id/alert-level', () => {
  it('sets the level, and null lets it follow again', async () => {
    let res = await put('/sessions/s1/alert-level', { level: 'urgent' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alertLevel: 'urgent' });
    expect(sessions.get('s1')).toMatchObject({ alertLevel: 'urgent', alerted: true, muted: false });

    res = await put('/sessions/s1/alert-level', { level: null });
    expect(await res.json()).toEqual({ ok: true, alertLevel: null });
    expect(sessions.get('s1')?.alertLevel).toBeUndefined();
  });

  it('refuses a level it does not know, and a session it does not have', async () => {
    expect((await put('/sessions/s1/alert-level', { level: 'deafening' })).status).toBe(400);
    expect((await put('/sessions/s1/alert-level', {})).status).toBe(400);
    expect((await put('/sessions/nope/alert-level', { level: 'loud' })).status).toBe(404);
    expect(setLevel).toHaveBeenCalledTimes(1);
  });
});

describe('the older Mute and Alert routes', () => {
  const levelAfter = async (path: string, body: unknown, start: Partial<Session> = {}): Promise<AlertLevel | null | 'unchanged'> => {
    sessions.set('s1', card('s1', start));
    setLevel.mockClear();
    const res = await put(path, body);
    expect(await res.json()).toEqual({ ok: true });
    return setLevel.mock.calls.length === 0 ? 'unchanged' : (setLevel.mock.calls[0][1] as AlertLevel | null);
  };

  it('Mute on is Silent; off lets a Silent session follow its room again', async () => {
    expect(await levelAfter('/sessions/s1/muted', { muted: true })).toBe('silent');
    expect(await levelAfter('/sessions/s1/muted', { muted: false }, { alertLevel: 'silent', muted: true })).toBeNull();
    expect(await levelAfter('/sessions/s1/muted', { muted: false }, { alertLevel: 'loud', alerted: true })).toBe('unchanged');
  });

  it('Mute off makes a session Normal when its room is Silent, so the switch does what it says', async () => {
    rooms = [{ id: 'r1', name: 'Quiet room', sessionIds: ['s1'], collapsed: false, createdAt: 0, alertLevel: 'silent' }] as Room[];
    expect(await levelAfter('/sessions/s1/muted', { muted: false }, { alertLevel: 'silent', muted: true })).toBe('normal');
  });

  // Nov 25 2026 (review): the room list is the window's last copy, which can still name a session by its id from before
  // a re-key. Read raw, the session followed no room, so Mute off cleared its level and it stayed Silent by the room.
  it('finds the room that lists the session under an older id', async () => {
    aliases.set('s0', 's1');
    rooms = [{ id: 'r1', name: 'Quiet room', sessionIds: ['s0'], collapsed: false, createdAt: 0, alertLevel: 'silent' }] as Room[];
    expect(await levelAfter('/sessions/s1/muted', { muted: false }, { alertLevel: 'silent', muted: true })).toBe('normal');
    rooms = [{ id: 'r1', name: 'Loud room', sessionIds: ['s0'], collapsed: false, createdAt: 0, alertLevel: 'loud' }] as Room[];
    expect(await levelAfter('/sessions/s1/alerted', { alerted: false }, { alertLevel: 'loud', alerted: true })).toBe('normal');
  });

  it('Alert on is Loud and leaves Urgent alone; off lets the session follow again', async () => {
    expect(await levelAfter('/sessions/s1/alerted', { alerted: true })).toBe('loud');
    expect(await levelAfter('/sessions/s1/alerted', { alerted: true }, { alertLevel: 'urgent', alerted: true })).toBe('unchanged');
    expect(await levelAfter('/sessions/s1/alerted', { alerted: false }, { alertLevel: 'loud', alerted: true })).toBeNull();
  });

  it('a session with only the older switch is read as its level', async () => {
    expect(await levelAfter('/sessions/s1/alerted', { alerted: false }, { alerted: true })).toBeNull();
  });

  it('still answers ok for a session it does not have, and 400 for a body that is not a switch', async () => {
    const res = await put('/sessions/ghost/muted', { muted: true });
    expect(await res.json()).toEqual({ ok: true });
    expect(setLevel).not.toHaveBeenCalled();
    expect((await put('/sessions/s1/alerted', { alerted: 'yes' })).status).toBe(400);
  });
});

describe('GET and PUT /alert-levels', () => {
  it('answers the defaults, then what was saved', async () => {
    expect(await (await fetch(`${base}/alert-levels`)).json()).toEqual({ ok: true, config: DEFAULT_ALERT_CONFIG });
    const next = withNormal({ notify: 'all' });
    const res = await put('/alert-levels', next);
    expect(await res.json()).toEqual({ ok: true, config: next });
    expect(await (await fetch(`${base}/alert-levels`)).json()).toEqual({ ok: true, config: next });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(next);
  });

  it('refuses part of a table, and keeps Silent silent', async () => {
    expect((await put('/alert-levels', { defaultLevel: 'loud' })).status).toBe(400);
    const loudSilent = { ...DEFAULT_ALERT_CONFIG, levels: { ...DEFAULT_ALERT_CONFIG.levels, silent: DEFAULT_ALERT_CONFIG.levels.loud } };
    const body = await (await put('/alert-levels', loudSilent)).json() as { config: AlertConfig };
    expect(body.config.levels.silent).toEqual(DEFAULT_ALERT_CONFIG.levels.silent);
  });

  it('is changed from this Mac only: another device reads the table, and its write is a 404', async () => {
    const res = await put('/alert-levels', withNormal({ notify: 'all' }), true);
    expect(res.status).toBe(404);
    expect(await (await fetch(`${base}/alert-levels`, { headers: { 'X-Test-Remote': '1' } })).json()).toEqual({ ok: true, config: DEFAULT_ALERT_CONFIG });
  });

  it("lets another device set a session's own level (the session route's visibility gate decides that)", async () => {
    const res = await put('/sessions/s1/alert-level', { level: 'quiet' }, true);
    expect(await res.json()).toEqual({ ok: true, alertLevel: 'quiet' });
  });
});
