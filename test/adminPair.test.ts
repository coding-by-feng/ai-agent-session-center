// test/adminPair.test.ts — `aasc-server pair` and the admin CLI's HTTP client (terminal-editions §8.1–8.3).
//
// Allow always needs a person: there is no --yes, a y/N prompt shows the device's label, platform
// and confirm code (a pairing code can be redeemed as any kind of device, open item M1), and N,
// Ctrl-C or a timeout deny it. The server is a fake: every request the command makes is recorded.
import { describe, it, expect, vi, afterAll } from 'vitest';
import { writeFileSync, chmodSync, symlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { runPair, PAIR_POLL_MS, type PairDeps } from '../cli/server/pair.js';
import { runDevices } from '../cli/server/devices.js';
import { AdminError, EXIT, readOwnerToken, resolveAdminPort, safeText, type AdminClient, type AdminResponse } from '../cli/server/http.js';
import { scratch, cleanScratch } from './helpers/headlessBundle.js';

afterAll(() => cleanScratch());

const LINK = 'https://aasc.work/pair#v=2&name=box&ts=100.64.0.1&p=3333&mc=ABCD-1234';
const NOW = 1_800_000_000_000;

interface Device { id: string; label: string; platform: 'ios' | 'android' | 'desktop'; status: 'pending' | 'active'; confirmCode: string | null; createdAt: number; lastSeenAt: number | null; online?: boolean }

/** A fake server: GET /devices answers from `lists` in turn (the last one repeats). */
function fakeServer(lists: Device[][], overrides: Record<string, AdminResponse> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  let listCall = 0;
  const client: AdminClient = {
    async request(method, path, body) {
      calls.push({ method, path, ...(body !== undefined ? { body } : {}) });
      const key = `${method} ${path}`;
      if (overrides[key]) return overrides[key];
      if (key === 'GET /api/mobile/devices') {
        const devices = lists[Math.min(listCall++, lists.length - 1)];
        return { status: 200, body: { success: true, data: { devices, pairingOffered: true } } };
      }
      if (key === 'POST /api/mobile/pairing') {
        return { status: 200, body: { success: true, data: { code: 'ABCD-1234', codeRef: 'ref-1', expiresAt: NOW + 10 * 60_000, link: LINK, target: {} } } };
      }
      if (method === 'POST' && path.endsWith('/approve')) return { status: 200, body: { success: true, data: { device: {} } } };
      if (method === 'DELETE') return { status: 200, body: { success: true } };
      return { status: 404, body: { error: 'Not found' } };
    },
  };
  return { client, calls };
}

const pending = (over: Partial<Device> = {}): Device => ({
  id: 'd7c1a9b2-0000-4000-8000-000000000001', label: 'Kasons-MacBook-Air', platform: 'desktop', status: 'pending',
  confirmCode: '482913', createdAt: NOW, lastSeenAt: null, ...over,
});

function deps(client: AdminClient, answer: string | null, over: Partial<PairDeps> = {}) {
  const lines: string[] = [];
  const questions: string[] = [];
  let clock = NOW;
  const d: PairDeps = {
    client,
    include: undefined,
    invert: false,
    interactive: true,
    out: (line) => lines.push(line),
    ask: vi.fn(async (q: string) => { questions.push(q); return answer; }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    cancelled: new AbortController().signal,
    qr: (text, opts) => `[QR ${text}${opts.invert ? ' inverted' : ''}]`,
    ...over,
  };
  return { d, lines, questions, text: () => lines.join('\n') };
}

describe('aasc-server pair', () => {
  it('prints the link and the QR, then waits for a device', async () => {
    const { client } = fakeServer([[], [pending()]]);
    const { d, text } = deps(client, 'y');
    await runPair(d);
    expect(text()).toContain(LINK);
    expect(text()).toContain(`[QR ${LINK}]`);
    expect(text()).toMatch(/this link works for 10 minutes/);
    expect(text()).toMatch(/Waiting for a device/);
  });

  it('asks with the label, the platform and the confirm code, and y approves', async () => {
    const { client, calls } = fakeServer([[], [], [pending()]]);
    const { d, questions, text } = deps(client, 'y');
    expect(await runPair(d)).toBe(EXIT.OK);
    expect(questions).toHaveLength(1);
    // The label is server-supplied text: quoted, on a line of its own, apart from what AASC vouches for.
    expect(questions[0]).toMatch(/\n  "Kasons-MacBook-Air" wants to pair\.\n  Computer · check it shows 482 913\. Allow\? \[y\/N\] $/);
    expect(questions[0]).toMatch(/\[y\/N\]/);
    expect(calls).toContainEqual({ method: 'POST', path: `/api/mobile/devices/${pending().id}/approve` });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(text()).toMatch(/Paired Kasons-MacBook-Air\. It sees shared sessions only/);
  });

  it('polls every 2 seconds', async () => {
    const { client } = fakeServer([[], [], [], [pending()]]);
    const sleeps: number[] = [];
    const { d } = deps(client, 'y', { sleep: async (ms) => { sleeps.push(ms); } });
    await runPair(d);
    expect(PAIR_POLL_MS).toBe(2000);
    expect(sleeps.every((ms) => ms === PAIR_POLL_MS)).toBe(true);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['N', 'n'],
    ['an empty answer (the default is No)', ''],
    ['anything but y', 'sure'],
  ])('denies on %s', async (_name, answer) => {
    const { client, calls } = fakeServer([[], [pending({ platform: 'ios', label: 'iPhone' })]]);
    const { d, questions } = deps(client, answer);
    expect(await runPair(d)).toBe(EXIT.FAILED);
    expect(questions[0]).toMatch(/"iPhone" wants to pair\.\n  Phone · iOS · check it shows/);
    expect(calls).toContainEqual({ method: 'DELETE', path: `/api/mobile/devices/${pending().id}` });
    expect(calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
  });

  it('denies on Ctrl-C or the answer timing out (ask gives null)', async () => {
    const { client, calls } = fakeServer([[], [pending()]]);
    const { d } = deps(client, null);
    expect(await runPair(d)).toBe(EXIT.FAILED);
    expect(calls).toContainEqual({ method: 'DELETE', path: `/api/mobile/devices/${pending().id}` });
  });

  it('gives the prompt ten minutes', async () => {
    const { client } = fakeServer([[], [pending()]]);
    const { d } = deps(client, 'n');
    await runPair(d);
    expect(d.ask).toHaveBeenCalledWith(expect.any(String), 10 * 60_000);
  });

  it('exits 1 when the link expires with nobody asking, withdraws the code and denies no device', async () => {
    const { client, calls } = fakeServer([[]]);
    const { d, text } = deps(client, 'y');
    expect(await runPair(d)).toBe(EXIT.FAILED);
    expect(text()).toMatch(/expired/);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([{ method: 'DELETE', path: '/api/mobile/pairing/ref-1' }]);
    expect(calls.some((c) => c.path.endsWith('/approve'))).toBe(false);
  });

  it('exits 1 on Ctrl-C or SIGTERM while waiting, and withdraws the code so the link dies now', async () => {
    const { client, calls } = fakeServer([[]]);
    const ctl = new AbortController();
    const { d, text } = deps(client, 'y', { sleep: async () => { ctl.abort(); }, cancelled: ctl.signal });
    expect(await runPair(d)).toBe(EXIT.FAILED);
    expect(text()).toMatch(/Cancelled\. The link no longer works/);
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/mobile/pairing/ref-1' });
  });

  it('still exits on cancel when the server could not withdraw the code', async () => {
    const { client } = fakeServer([[]], { 'DELETE /api/mobile/pairing/ref-1': { status: 500, body: { error: 'boom' } } });
    const ctl = new AbortController();
    const { d, text } = deps(client, 'y', { sleep: async () => { ctl.abort(); }, cancelled: ctl.signal });
    expect(await runPair(d)).toBe(EXIT.FAILED);
    expect(text()).toMatch(/stops working when it expires/);
  });

  it('does not withdraw the code once a device has used it', async () => {
    const { client, calls } = fakeServer([[], [pending()]]);
    const { d } = deps(client, 'y');
    await runPair(d);
    expect(calls.some((c) => c.path.startsWith('/api/mobile/pairing/'))).toBe(false);
  });

  it('ignores devices that were already listed before the link was made', async () => {
    const old = pending({ id: 'old-pending', label: 'Old' });
    const { client, calls } = fakeServer([[old], [old], [old, pending()]]);
    const { d, questions } = deps(client, 'y');
    await runPair(d);
    expect(questions[0]).toMatch(/Kasons-MacBook-Air/);
    expect(calls.some((c) => c.path.includes('old-pending'))).toBe(false);
  });

  it('strips terminal control sequences from a device label before showing it', async () => {
    const { client } = fakeServer([[], [pending({ label: 'Evil\u001b]0;pwned\u0007\u001b[2J\nPhone' })]]);
    const { d, questions } = deps(client, 'n');
    await runPair(d);
    expect(questions[0]).not.toMatch(/[\u001b\u0007\u009b]/);
    expect(questions[0]).toMatch(/"Evil.*Phone" wants to pair/);
  });

  it('refuses to run without a terminal: Allow needs a person', async () => {
    const { client, calls } = fakeServer([[]]);
    const { d, text } = deps(client, 'y', { interactive: false });
    expect(await runPair(d)).toBe(EXIT.FAILED);
    expect(text()).toMatch(/needs a terminal/);
    expect(calls).toEqual([]);
  });

  it('passes the chosen addresses and --invert', async () => {
    const { client, calls } = fakeServer([[], [pending()]]);
    const { d, text } = deps(client, 'y', { include: ['tailnet', 'public'], invert: true });
    await runPair(d);
    expect(calls).toContainEqual({ method: 'POST', path: '/api/mobile/pairing', body: { include: ['tailnet', 'public'] } });
    expect(text()).toContain(`[QR ${LINK} inverted]`);
  });

  it('says why the server refused to make a link, and exits 1', async () => {
    const { client } = fakeServer([[]], {
      'POST /api/mobile/pairing': { status: 409, body: { error: 'Set a dashboard password first.', code: 'PASSWORD_REQUIRED' } },
    });
    const { d, text } = deps(client, 'y');
    expect(await runPair(d)).toBe(EXIT.FAILED);
    expect(text()).toMatch(/Set a dashboard password first/);
  });
});

describe('aasc-server devices', () => {
  const list = [
    { ...pending({ id: 'a1b2c3d4-1111', label: 'Kasons-MacBook-Air', status: 'active', confirmCode: null, lastSeenAt: NOW }), online: true },
    { ...pending({ id: 'e5f6a7b8-2222', label: 'iPhone', platform: 'ios', status: 'active', confirmCode: null, lastSeenAt: NOW - 2 * 3600_000 }), online: false },
    pending({ id: 'c9d0e1f2-3333', label: 'macbook-pro' }),
  ];

  it('lists id, name, kind, status and last seen', async () => {
    const { client } = fakeServer([list]);
    const lines: string[] = [];
    expect(await runDevices({ client, args: [], json: false, out: (l) => lines.push(l), now: () => NOW })).toBe(EXIT.OK);
    const text = lines.join('\n');
    expect(text).toMatch(/ID\s+NAME\s+KIND\s+STATUS\s+LAST SEEN/);
    expect(text).toMatch(/a1b2c3d4\s+Kasons-MacBook-Air\s+computer\s+online\s+now/);
    expect(text).toMatch(/e5f6a7b8\s+iPhone\s+phone\s+paired\s+2 h ago/);
    expect(text).toMatch(/c9d0e1f2\s+macbook-pro\s+computer\s+waiting for Allow/);
  });

  it('prints JSON with --json', async () => {
    const { client } = fakeServer([list]);
    const lines: string[] = [];
    await runDevices({ client, args: [], json: true, out: (l) => lines.push(l), now: () => NOW });
    expect(JSON.parse(lines.join('\n')).devices).toHaveLength(3);
  });

  it('revokes by the short id it lists', async () => {
    const { client, calls } = fakeServer([list]);
    const lines: string[] = [];
    expect(await runDevices({ client, args: ['revoke', 'e5f6a7b8'], json: false, out: (l) => lines.push(l), now: () => NOW })).toBe(EXIT.OK);
    expect(calls).toContainEqual({ method: 'DELETE', path: '/api/mobile/devices/e5f6a7b8-2222' });
    expect(lines.join('\n')).toMatch(/Revoked iPhone\. Its connections were closed/);
  });

  it('renames', async () => {
    const { client, calls } = fakeServer([list], { 'PATCH /api/mobile/devices/a1b2c3d4-1111': { status: 200, body: { success: true } } });
    expect(await runDevices({ client, args: ['rename', 'a1b2', 'Air'], json: false, out: () => {}, now: () => NOW })).toBe(EXIT.OK);
    expect(calls).toContainEqual({ method: 'PATCH', path: '/api/mobile/devices/a1b2c3d4-1111', body: { label: 'Air' } });
  });

  it('refuses an unknown or ambiguous id', async () => {
    const { client, calls } = fakeServer([list]);
    expect(await runDevices({ client, args: ['revoke', 'ffff'], json: false, out: () => {}, now: () => NOW })).toBe(EXIT.FAILED);
    expect(await runDevices({ client, args: ['revoke', ''], json: false, out: () => {}, now: () => NOW })).toBe(EXIT.FAILED);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('the admin HTTP client', () => {
  const token = 'ab'.repeat(32);

  it('reads owner.token when it is 0600 and ours', () => {
    const dir = scratch('admin');
    writeFileSync(join(dir, 'owner.token'), `${token}\n`, { mode: 0o600 });
    expect(readOwnerToken(dir)).toBe(token);
  });

  it('says the server is not running (exit 2) when there is no token', () => {
    const dir = scratch('admin');
    expect(() => readOwnerToken(dir)).toThrow(AdminError);
    try { readOwnerToken(dir); } catch (err) { expect((err as AdminError).exitCode).toBe(EXIT.NOT_RUNNING); }
  });

  it('refuses a token others can read, a symlink and one owned by someone else', () => {
    const dir = scratch('admin');
    const path = join(dir, 'owner.token');
    writeFileSync(path, `${token}\n`);
    chmodSync(path, 0o644);
    expect(() => readOwnerToken(dir)).toThrow(/chmod 600/);
    chmodSync(path, 0o600);
    expect(() => readOwnerToken(dir, { uid: (process.getuid?.() ?? 0) + 1 })).toThrow(/another user/);
    const linked = scratch('admin');
    symlinkSync(path, join(linked, 'owner.token'));
    expect(() => readOwnerToken(linked)).toThrow(/not a regular file/);
  });

  it('finds the port: --port, then the folder lock, then the config', () => {
    const dir = scratch('admin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'server-config.json'), JSON.stringify({ port: 4100 }));
    expect(resolveAdminPort({ dataDir: dir, flagPort: undefined, env: {} })).toBe(4100);
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 1, port: 4200, edition: 'headless', startedAt: 1, dataDir: dir }));
    expect(resolveAdminPort({ dataDir: dir, flagPort: undefined, env: {} })).toBe(4200);
    expect(resolveAdminPort({ dataDir: dir, flagPort: '4300', env: {} })).toBe(4300);
    expect(() => resolveAdminPort({ dataDir: dir, flagPort: '99999', env: {} })).toThrow(AdminError);
  });

  it('strips control characters from server-supplied text', () => {
    expect(safeText('a\u001b[31mb\u0007c\nd\u009be')).toBe('a[31mbc de');
  });

  it('strips format characters and line/paragraph separators: bidi overrides can disguise a label', () => {
    // U+202E (right-to-left override), U+2066..2069 (isolates), U+200B (zero width space), U+FEFF.
    expect(safeText('Mac\u202eriA\u2066x\u2069\u200b\ufeffBook')).toBe('MacriAxBook');
    expect(safeText('one\u2028two\u2029three')).toBe('one two three');
  });
});
