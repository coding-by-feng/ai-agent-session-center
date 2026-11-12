// @vitest-environment jsdom
// Plan 17: enrolling this phone with an account Mac (ticket → POST /api/mobile/enroll → sealed token).
import { afterEach, describe, expect, it } from 'vitest';
import { enrollViaAccount, type EnrollOutcome } from './accountEnroll';
import { listAccountMacs, type AccountMac } from './accountMacs';
import { ACCOUNT_VAULT_KEY, currentAccount, signInWithGoogle } from './accountSignIn';
import type { FakeEnrollRefusal, StrangerEnroll } from './dev/fakeMac';
import type { BrowseResult } from './lanRescan';
import { loadMacs, MACS_KEY, readMacCredentials } from './savedMacs';
import { createHarness, LAN, TAILNET } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

const RELAY = 'http://192.168.1.30:3333';
const bonjour = (...hosts: string[]) => async (): Promise<BrowseResult> => ({
  services: hosts.map((h) => ({ host: new URL(h).hostname, port: Number(new URL(h).port) })),
  local: ['192.168.1.5'],
});

async function signedIn(opts: Parameters<typeof createHarness>[0] = {}) {
  const t = createHarness({ authSession: true, ...opts });
  await signInWithGoogle(t.deps, 'Pixel');
  const listed = await listAccountMacs(t.deps);
  if (listed.status !== 'ok') throw new Error(listed.status);
  t.mac.calls.length = 0;
  return { t, listed: listed.macs };
}

const enrollCalls = (t: ReturnType<typeof createHarness>) => t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/enroll'));
const ticketCalls = (t: ReturnType<typeof createHarness>) => t.mac.calls.filter((c) => c.url === 'https://api.aasc.work/v1/enroll/tickets');
const message = (out: EnrollOutcome) => (out.ok ? '' : out.message);

function expectNothingSaved(t: ReturnType<typeof createHarness>) {
  expect([...t.vault.keys()].filter((k) => k !== ACCOUNT_VAULT_KEY)).toEqual([]);
  expect(JSON.parse(t.store.get(MACS_KEY) ?? '[]')).toEqual([]);
}

describe('enrollViaAccount', () => {
  it('happy path over Tailscale: one ticket, the token sealed to this phone, the Mac saved active', async () => {
    const { t, listed } = await signedIn();
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({
      name: 'Kason-MBP', port: 3333, tailnet: '100.101.102.103', lan: null, lanAllowed: false, status: 'active',
      backendDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', confirmCode: null, phoneName: 'Pixel', lastPath: 'tailnet',
    });
    expect(await loadMacs(t.deps.store)).toEqual([out.mac]);
    expect(out.mac.unconfirmed).toBe(true); // until its first /session (the Mac drops it after 2 min without one)
    const creds = await readMacCredentials(t.deps.vault, out.mac.id);
    const [enrolledId] = t.mac.enrolled();
    expect(creds?.deviceId).toBe(enrolledId);
    expect(creds?.deviceToken).toBe(t.mac.devices.get(enrolledId)?.token);
    expect(ticketCalls(t)).toHaveLength(1);
    expect(ticketCalls(t)[0].body).toEqual({ macDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', phoneKey: expect.stringMatching(/^[A-Za-z0-9_-]{87}$/) });
    const [call] = enrollCalls(t);
    expect(call.url).toBe(`${TAILNET}/api/mobile/enroll`);
    const body = call.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['label', 'macDeviceId', 'nonce', 'phoneKey', 'platform', 'ticket']);
    expect(body).toMatchObject({ macDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', label: 'Pixel', platform: 'android', nonce: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(body.phoneKey).toBe((ticketCalls(t)[0].body as { phoneKey: string }).phoneKey);
  });

  it('never keeps a ticket, token or key in Preferences or in what it returns', async () => {
    const { t, listed } = await signedIn();
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    const ticket = (enrollCalls(t)[0].body as { ticket: string }).ticket;
    const secrets = [...t.mac.issued, ticket];
    const shown = JSON.stringify(out);
    for (const s of secrets) {
      expect(shown).not.toContain(s);
      for (const v of t.store.values()) expect(v).not.toContain(s);
    }
  });

  it('finds a Mac with no Tailscale address on this Wi-Fi through Bonjour, and allows the home network for it', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [LAN] }, discovery: bonjour(LAN) });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null }, { phoneName: 'Pixel' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({ lan: '192.168.1.20', tailnet: null, lanAllowed: true, lastPath: 'lan' });
  });

  it('skips Bonjour services outside the private ranges', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: ['http://8.8.8.8:3333'] }, discovery: bonjour('http://8.8.8.8:3333') });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null }, { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(t.mac.calls.some((c) => c.url.startsWith('http://8.8.8.8'))).toBe(false);
  });

  it('NOT_THIS_MAC: tries the next address with the same ticket', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [LAN], strangers: [TAILNET] }, discovery: bonjour(LAN) });
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac.lan).toBe('192.168.1.20');
    expect(ticketCalls(t)).toHaveLength(1);
    const calls = enrollCalls(t);
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([TAILNET, LAN]);
    expect((calls[0].body as { ticket: string }).ticket).toBe((calls[1].body as { ticket: string }).ticket);
  });

  it('a relay that passes the request to the real Mac gets a seal for the Mac’s address: refused, nothing saved', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [TAILNET], relays: [RELAY] }, discovery: bonjour(RELAY) });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null }, { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'invalid' });
    expect(message(out)).toContain('nothing was saved');
    expect(t.mac.enrolled()).toHaveLength(1); // the Mac did seal, for its own address
    expectNothingSaved(t);
  });

  it('asks for no ticket when nothing answers, and says nothing was saved', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [] } });
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(message(out)).toContain('Nothing was saved');
    expect(ticketCalls(t)).toHaveLength(0);
    expectNothingSaved(t);
  });

  it.each<[FakeEnrollRefusal, RegExp]>([
    ['INVALID_TICKET', /refused the sign-in/],
    ['CLOUD_UNAVAILABLE', /couldn’t reach AASC Cloud/],
  ])('%s maps to a short message and saves nothing', async (code, text) => {
    const { t, listed } = await signedIn();
    t.mac.refuseNextEnroll(code);
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'refused' });
    expect(message(out)).toMatch(text);
    expect(message(out)).toContain('Nothing was saved');
    expectNothingSaved(t);
  });

  it('ACCOUNT_ENROLL_OFF from every address says where to turn it on (each address is still tried)', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [TAILNET, LAN] }, discovery: bonjour(LAN) });
    t.mac.setAccountEnroll(false);
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(message(out)).toMatch(/devices panel/);
    expect(enrollCalls(t)).toHaveLength(2);
    expectNothingSaved(t);
  });

  it('INVALID_TICKET stops at once: the real Mac used or refused the ticket', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [TAILNET, LAN] }, discovery: bonjour(LAN) });
    t.mac.refuseNextEnroll('INVALID_TICKET');
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(message(out)).toMatch(/refused the sign-in/);
    expect(enrollCalls(t)).toHaveLength(1);
  });

  it.each<StrangerEnroll>(['NOT_THIS_MAC', 'ACCOUNT_ENROLL_OFF', 'REMOTE_PASSWORD_REQUIRED', 'RATE_LIMITED', 'ENROLL_BUSY', 'TOO_MANY_NEW_PHONES', 'FORGE'])(
    'a stranger answering %s first doesn’t stop the right Mac from enrolling, with the same ticket',
    async (behaviour) => {
      const { t, listed } = await signedIn({
        mac: { reachable: [LAN], strangers: [TAILNET], strangerEnroll: { [TAILNET]: behaviour } }, discovery: bonjour(LAN),
      });
      const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
      if (!out.ok) throw new Error(out.message);
      expect(out.mac.lan).toBe('192.168.1.20');
      expect(await readMacCredentials(t.deps.vault, out.mac.id)).toMatchObject({ deviceId: t.mac.enrolled()[0] });
      expect(ticketCalls(t)).toHaveLength(1);
      expect(enrollCalls(t).map((c) => new URL(c.url).origin)).toEqual([TAILNET, LAN]);
    },
  );

  it.each<[StrangerEnroll, RegExp]>([
    ['ACCOUNT_ENROLL_OFF', /doesn’t let account sign-ins connect/],
    ['REMOTE_PASSWORD_REQUIRED', /needs a dashboard password before phones can connect/],
    ['RATE_LIMITED', /Too many tries/],
    ['ENROLL_BUSY', /^Kason-MBP is busy connecting another phone\. Try again in a few seconds\. Nothing was saved\.$/],
    ['TOO_MANY_NEW_PHONES', /^Kason-MBP has too many phones waiting to connect\. Try again in a couple of minutes\. Nothing was saved\.$/],
  ])('only %s answered: that is what the phone says, and nothing is saved', async (behaviour, text) => {
    const { t, listed } = await signedIn({ mac: { reachable: [], strangers: [TAILNET], strangerEnroll: { [TAILNET]: behaviour } } });
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'refused' });
    expect(message(out)).toMatch(text);
    expect(message(out)).toContain('Nothing was saved');
    expectNothingSaved(t);
  });

  it('a box that seals its own token to this phone’s key for the dialled address is refused, nothing saved (C1)', async () => {
    const BOX = 'http://192.168.1.30:3333';
    const { t, listed } = await signedIn({ mac: { reachable: [], strangers: [BOX], strangerEnroll: { [BOX]: 'FORGE' } }, discovery: bonjour(BOX) });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null }, { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'invalid' });
    expect(message(out)).toContain('nothing was saved');
    expectNothingSaved(t);
  });

  it('never sends the ticket’s seal secret anywhere but keeps it in memory', async () => {
    const { t, listed } = await signedIn();
    await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    const ticket = (enrollCalls(t)[0].body as { ticket: string }).ticket;
    const ticketAnswerSecret = t.mac.issued[t.mac.issued.indexOf(ticket) + 1]; // the backend issues the seal secret right after it
    expect(ticketAnswerSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const after = t.mac.calls.filter((c) => !c.url.endsWith('/v1/enroll/tickets'));
    for (const c of after) expect(JSON.stringify(c)).not.toContain(ticketAnswerSecret);
  });

  it('a Mac on the default port 80 is sealed for and saved with port 80', async () => {
    const PORT80 = 'http://192.168.1.20';
    const { t, listed } = await signedIn({
      mac: { reachable: [PORT80] },
      discovery: async () => ({ services: [{ host: '192.168.1.20', port: 80 }], local: ['192.168.1.5'] }),
    });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null, port: 80 }, { phoneName: 'Pixel' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({ lan: '192.168.1.20', port: 80 });
  });

  it('the real Mac’s own TOO_MANY_NEW_PHONES and ENROLL_BUSY are refusals with their own words, nothing saved', async () => {
    for (const [code, text] of [['TOO_MANY_NEW_PHONES', /too many phones waiting/], ['ENROLL_BUSY', /busy connecting another phone/]] as const) {
      const { t, listed } = await signedIn();
      t.mac.refuseNextEnroll(code);
      const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
      expect(out).toMatchObject({ ok: false, reason: 'refused' });
      expect(message(out)).toMatch(text);
      expect(await currentAccount(t.deps)).not.toBeNull();
      expectNothingSaved(t);
    }
  });

  it('a TOO_MANY_NEW_PHONES stranger never hides a more specific refusal from the real Mac', async () => {
    const { t, listed } = await signedIn({
      mac: { reachable: [LAN], strangers: [TAILNET], strangerEnroll: { [TAILNET]: 'TOO_MANY_NEW_PHONES' } }, discovery: bonjour(LAN),
    });
    t.mac.setAccountEnroll(false);
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(message(out)).toMatch(/doesn’t let account sign-ins connect/);
  });

  it('PHONE_REVOKED from a Mac the backend contradicts: that Mac removed this phone; the account stays', async () => {
    const { t, listed } = await signedIn();
    t.mac.refuseNextEnroll('PHONE_REVOKED');
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'refused' });
    expect(message(out)).toBe('Kason-MBP removed this phone. Nothing was saved.');
    expect(await currentAccount(t.deps)).not.toBeNull();
    expect(t.mac.calls.some((c) => c.url === 'https://api.aasc.work/v1/enroll/macs')).toBe(true);
    expectNothingSaved(t);
  });

  it('PHONE_REVOKED that the backend confirms (401) signs the phone out', async () => {
    const { t, listed } = await signedIn();
    t.mac.refuseNextEnroll('PHONE_REVOKED');
    const revoking = { ...t.deps, http: { post: async (url: string, body: unknown) => {
      if (url.endsWith('/api/mobile/enroll')) t.mac.account.revokeDevice(t.mac.account.devices()[0]);
      return t.deps.http.post(url, body);
    } } };
    expect(await enrollViaAccount(revoking, [], listed[0], { phoneName: 'Pixel' })).toMatchObject({ ok: false, reason: 'signed-out' });
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('a phone revoked after its ticket: the backend dropped the ticket, so the Mac answers INVALID_TICKET', async () => {
    const { t, listed } = await signedIn();
    const revoking = { ...t.deps, http: { post: async (url: string, body: unknown) => {
      if (url.endsWith('/api/mobile/enroll')) t.mac.account.revokeDevice(t.mac.account.devices()[0]);
      return t.deps.http.post(url, body);
    } } };
    const out = await enrollViaAccount(revoking, [], listed[0], { phoneName: 'Pixel' });
    expect(message(out)).toMatch(/refused the sign-in/);
    expect(t.mac.enrolled()).toHaveLength(0);
    expectNothingSaved(t);
  });

  it('a 401 for the ticket signs the phone out; a Mac gone from the account says so', async () => {
    const { t, listed } = await signedIn();
    t.mac.account.setMacs([]);
    expect(message(await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' }))).toMatch(/no longer on your AASC Cloud account/);
    t.mac.account.revokeDevice(t.mac.account.devices()[0]);
    expect(await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' })).toMatchObject({ ok: false, reason: 'signed-out' });
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('a 403 for the ticket (a token without macs:enroll) signs the phone out to sign in again', async () => {
    const { t, listed } = await signedIn();
    const forbidding = { ...t.deps, requester: {
      request: async (req: Parameters<typeof t.deps.requester.request>[0]) => (req.url.endsWith('/v1/enroll/tickets')
        ? { status: 403, data: { success: false, error: { code: 'forbidden', message: 'Forbidden' } } }
        : t.deps.requester.request(req)),
    } };
    expect(await enrollViaAccount(forbidding, [], listed[0], { phoneName: 'Pixel' })).toMatchObject({ ok: false, reason: 'signed-out' });
    expect(await currentAccount(t.deps)).toBeNull();
  });

  it('a vault that won’t take the key: the phone removes itself from the Mac again, nothing saved', async () => {
    const { t, listed } = await signedIn();
    const failing = { ...t.deps, vault: { ...t.deps.vault, set: async () => { throw new Error('keystore'); } } };
    const out = await enrollViaAccount(failing, [], listed[0], { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'storage' });
    expect(t.mac.devices.get(t.mac.enrolled()[0])?.status).toBe('revoked');
    expectNothingSaved(t);
  });

  it('asks nothing when signed out', async () => {
    const t = createHarness();
    const mac: AccountMac = { deviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', name: 'Kason-MBP', tailnet: '100.101.102.103', port: 3333, lastUsedAt: null };
    expect(await enrollViaAccount(t.deps, [], mac, { phoneName: 'Pixel' })).toMatchObject({ ok: false, reason: 'signed-out' });
    expect(t.mac.calls).toHaveLength(0);
  });

  it('a user who moves on while the Mac is being saved still gets a session on it (the Mac drops an unused row in 2 min)', async () => {
    const { t, listed } = await signedIn();
    let movedOn = false;
    const vault = { ...t.deps.vault, set: async (k: string, v: string) => {
      if (k !== ACCOUNT_VAULT_KEY) movedOn = true; // the user leaves while the key is written
      return t.deps.vault.set(k, v);
    } };
    const out = await enrollViaAccount({ ...t.deps, vault }, [], listed[0], { phoneName: 'Pixel', proceed: () => !movedOn });
    if (!out.ok) throw new Error(out.message);
    expect(movedOn).toBe(true);
    const sessions = t.mac.calls.filter((c) => c.url === `${TAILNET}/api/mobile/session`);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].body).toMatchObject({ deviceId: t.mac.enrolled()[0] });
    expect(out.mac).not.toHaveProperty('unconfirmed');
    expect((await loadMacs(t.deps.store))[0]).not.toHaveProperty('unconfirmed');
  });

  it('the user still here: no extra session (the caller opens the Mac at once)', async () => {
    const { t, listed } = await signedIn();
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(out.ok).toBe(true);
    expect(t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/session'))).toHaveLength(0);
  });

  it('stops once the user moves on', async () => {
    const { t, listed } = await signedIn();
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel', proceed: () => false });
    expect(out).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(ticketCalls(t)).toHaveLength(0);
  });
});
