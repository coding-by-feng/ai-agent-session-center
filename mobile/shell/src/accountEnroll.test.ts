// @vitest-environment jsdom
// Plan 17: enrolling this phone with an account Mac (ticket → POST /api/mobile/enroll → sealed token).
// Plan 18: the home-network address the account's directory hints at is one more address to try, on the same path
// as one Bonjour found, and only when the listed Tailscale address does not answer.
import { afterEach, describe, expect, it } from 'vitest';
import { enrollCandidates, enrollViaAccount, MAX_ENROLL_CANDIDATES, type EnrollOutcome } from './accountEnroll';
import { listAccountMacs, withDirectoryHints, type AccountMac } from './accountMacs';
import { ACCOUNT_VAULT_KEY, currentAccount, signInWithGoogle } from './accountSignIn';
import type { Candidate } from './connectionPlan';
import type { FakeEnrollRefusal, FakeMacOptions, StrangerEnroll } from './dev/fakeMac';
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
    expect(t.mac.calls.filter((c) => c.url.startsWith('https://')).map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.aasc.work/v1/enroll/tickets', 'GET https://api.aasc.work/v1/enroll/macs', // never the directory
    ]);
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

  it('a sign-in the phone can’t read right now (a locked keychain) is not a sign-out: nothing asked, nothing forgotten', async () => {
    const { t, listed } = await signedIn();
    t.faults.vaultRead = true;
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel' });
    expect(out).toEqual({ ok: false, reason: 'refused', message: 'This phone can’t read its sign-in right now. Unlock it and try again. Nothing was saved.' });
    expect(t.mac.calls).toHaveLength(0);
    t.faults.vaultRead = false;
    expect(await currentAccount(t.deps)).not.toBeNull();
    expectNothingSaved(t);
  });

  it('a sign-in that can’t be read by the time the ticket is asked for is not a sign-out either', async () => {
    const { t, listed } = await signedIn();
    const out = await enrollViaAccount(t.deps, [], listed[0], { phoneName: 'Pixel', onTry: () => { t.faults.vaultRead = true; } });
    expect(out).toEqual({ ok: false, reason: 'refused', message: 'This phone can’t read its sign-in right now. Unlock it and try again. Nothing was saved.' });
    expect(ticketCalls(t)).toHaveLength(0);
    expect(enrollCalls(t)).toHaveLength(0);
    t.faults.vaultRead = false;
    expect(await currentAccount(t.deps)).not.toBeNull();
    expectNothingSaved(t);
  });

  it('asks nothing when signed out', async () => {
    const t = createHarness();
    const mac: AccountMac = { deviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', name: 'Kason-MBP', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, lastUsedAt: null };
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

describe('enrollCandidates', () => {
  const MAC: AccountMac = { deviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', name: 'Kason-MBP', lan: '192.168.1.20', tailnet: '100.101.102.103', port: 3333, lastUsedAt: null };
  const LISTED_LAN: Candidate = { kind: 'lan', origin: LAN, encrypted: false };
  const LISTED_TAILNET: Candidate = { kind: 'tailnet', origin: TAILNET, encrypted: true };
  const found = (host: string, port = 3333) => ({ host, port });

  it('the listed Tailscale address, then the listed home-network one, then what Bonjour found (the listed port first)', () => {
    expect(enrollCandidates(MAC, [found('192.168.1.31', 4000), found('192.168.1.30')])).toEqual([
      LISTED_TAILNET,
      LISTED_LAN,
      { kind: 'lan', origin: 'http://192.168.1.30:3333', encrypted: false },
      { kind: 'lan', origin: 'http://192.168.1.31:4000', encrypted: false },
    ]);
  });

  it('a listed home-network address is the same kind of candidate as a Bonjour one: the home network, unencrypted', () => {
    const [listed] = enrollCandidates({ ...MAC, tailnet: null }, []);
    const [byBonjour] = enrollCandidates({ ...MAC, lan: null, tailnet: null }, [found('192.168.1.20')]);
    expect(listed).toEqual(byBonjour);
    expect(listed).toEqual(LISTED_LAN);
  });

  it('each origin once: Bonjour finding the listed address adds nothing', () => {
    expect(enrollCandidates(MAC, [found('192.168.1.20'), found('192.168.1.20'), found('192.168.1.30')])).toEqual([
      LISTED_TAILNET, LISTED_LAN, { kind: 'lan', origin: 'http://192.168.1.30:3333', encrypted: false },
    ]);
  });

  it('the listed host on another port is another origin, tried after the listed ones', () => {
    expect(enrollCandidates(MAC, [found('192.168.1.20', 4000)])).toEqual([
      LISTED_TAILNET, LISTED_LAN, { kind: 'lan', origin: 'http://192.168.1.20:4000', encrypted: false },
    ]);
  });

  it.each<[string, Partial<AccountMac>]>([
    ['a public address', { lan: '8.8.8.8' }],
    ['a Tailscale address', { lan: '100.64.0.9' }],
    ['a leading-zero address', { lan: '192.168.01.20' }],
    ['a host name', { lan: 'mac.local' }],
    ['no port', { port: null }],
  ])('a listed home-network address that is %s is not a candidate', (_what, over) => {
    const out = enrollCandidates({ ...MAC, tailnet: null, ...over }, [found('192.168.1.30')]);
    expect(out).toEqual([{ kind: 'lan', origin: 'http://192.168.1.30:3333', encrypted: false }]);
  });

  it('with no listed home-network address the list is what it was before plan 18', () => {
    expect(enrollCandidates({ ...MAC, lan: null }, [found('192.168.1.20')])).toEqual([LISTED_TAILNET, LISTED_LAN]);
    expect(enrollCandidates({ ...MAC, lan: null }, [])).toEqual([LISTED_TAILNET]);
  });

  it('never more than the limit, the listed ones first', () => {
    const many = Array.from({ length: 20 }, (_, i) => found(`192.168.1.${100 + i}`));
    const out = enrollCandidates(MAC, many);
    expect(out).toHaveLength(MAX_ENROLL_CANDIDATES);
    expect(out.slice(0, 2)).toEqual([LISTED_TAILNET, LISTED_LAN]);
  });
});

describe('enrollViaAccount: the home-network address the account hints at (plan 18)', () => {
  const HOME = '192.168.1.20'; // LAN's host
  const OTHER = 'http://192.168.1.44:3333'; // something else Bonjour finds on this Wi-Fi
  const line = (c: { method: string; url: string }) => `${c.method} ${c.url}`;

  /**
   * One enroll, and everything it did, less what differs from run to run (ids, keys, tickets, nonces, tokens).
   * `target`: what to change on the account's Mac (its Tailscale address 100.101.102.103 and port 3333 are listed).
   */
  async function enroll(opts: Parameters<typeof createHarness>[0], target: Partial<AccountMac>) {
    const { t, listed } = await signedIn(opts);
    const tried: Candidate[] = [];
    const before: string[] = [];
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], ...target }, {
      phoneName: 'Pixel',
      onTry: (c) => {
        if (tried.length === 0) before.push(...t.mac.calls.map(line));
        tried.push(c);
      },
    });
    const saved = await loadMacs(t.deps.store);
    return {
      t,
      out,
      did: {
        requests: t.mac.calls.map(line),
        bodyKeys: t.mac.calls.map((c) => (c.body && typeof c.body === 'object' ? Object.keys(c.body).sort() : null)),
        tried,
        askedBeforeTheFirstTry: before,
        outcome: out.ok ? { ok: true, mac: { ...out.mac, id: '(id)' } } : out,
        saved: saved.map((m) => ({ ...m, id: '(id)' })),
        keysInVault: [...t.vault.keys()].filter((k) => k !== ACCOUNT_VAULT_KEY).length,
        enrolledOnTheMac: t.mac.enrolled().length,
        statuses: [...t.mac.devices.values()].map((d) => d.status),
      },
    };
  }

  /** The home-network address LAN for a Mac with no Tailscale address, found the old way (Bonjour) or hinted. */
  const atHome = (via: 'bonjour' | 'hinted', mac: FakeMacOptions) => enroll(
    { mac, discovery: via === 'bonjour' ? bonjour(LAN) : bonjour() },
    { tailnet: null, lan: via === 'hinted' ? HOME : null },
  );

  it('connects over the hinted address with no Bonjour at all, and saves what a Bonjour find saves', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [LAN] } }); // no discovery: this phone has no browser
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null, lan: HOME }, { phoneName: 'Pixel' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({
      name: 'Kason-MBP', port: 3333, lan: HOME, tailnet: null, lanAllowed: true, lastPath: 'lan', status: 'active',
      backendDeviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', unconfirmed: true,
    });
    expect(await loadMacs(t.deps.store)).toEqual([out.mac]);
    expect(await readMacCredentials(t.deps.vault, out.mac.id)).toMatchObject({ deviceId: t.mac.enrolled()[0] });
    expect(enrollCalls(t).map((c) => new URL(c.url).origin)).toEqual([LAN]);
    expect(ticketCalls(t)).toHaveLength(1);
  });

  it('end to end: the list, the directory’s hint for it, then an enroll at home with Tailscale not answering', async () => {
    const { t, listed } = await signedIn({
      mac: {
        reachable: [LAN],
        account: { macs: [{ deviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', name: 'Kason-MBP', lan: HOME, tailnet: '100.101.102.103', port: 3333 }] },
      },
    });
    expect(listed[0]).toMatchObject({ lan: null, tailnet: '100.101.102.103', port: 3333 });
    const [hinted] = await withDirectoryHints(t.deps, listed);
    expect(hinted).toMatchObject({ lan: HOME, tailnet: '100.101.102.103', port: 3333 });
    t.mac.calls.length = 0;
    const out = await enrollViaAccount(t.deps, [], hinted, { phoneName: 'Pixel' });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({ lan: HOME, tailnet: null, lanAllowed: true, lastPath: 'lan' });
    // Tailscale had its turn first; the hint was dialled only after it failed to answer.
    expect(t.mac.calls.map(line)).toEqual([
      `GET ${TAILNET}/api/auth/status`, `GET ${LAN}/api/auth/status`, 'POST https://api.aasc.work/v1/enroll/tickets', `POST ${LAN}/api/mobile/enroll`,
    ]);
  });

  // Tailscale first, and a phone whose Tailscale address answers does exactly what it did before the hint existed.
  it.each<[string, Parameters<typeof createHarness>[0]]>([
    ['the Mac answers on both', { mac: { reachable: [TAILNET, LAN] } }],
    ['the Mac answers on both, and Bonjour finds something else', { mac: { reachable: [TAILNET, LAN, OTHER] }, discovery: bonjour(OTHER) }],
    ['the Mac answers on Tailscale only', { mac: { reachable: [TAILNET] } }],
    ['the Mac refuses over Tailscale (sign-ins off)', { mac: { reachable: [TAILNET, LAN], accountEnroll: false } }],
    ['something else answers at the Tailscale address', { mac: { reachable: [LAN], strangers: [TAILNET] } }],
    ['a box at the Tailscale address answers 429', { mac: { reachable: [LAN], strangers: [TAILNET], strangerEnroll: { [TAILNET]: 'RATE_LIMITED' } } }],
  ])('Tailscale answers (%s): the hint is never dialled, and nothing differs from an enroll without it', async (_what, opts) => {
    const today = await enroll(opts, { lan: null });
    const hinted = await enroll(opts, { lan: HOME });
    expect(hinted.did).toEqual(today.did);
    expect(hinted.did.requests.filter((r) => r.includes(LAN))).toEqual([]); // not even a probe
    expect(hinted.did.saved.every((m) => m.lan === null && m.lanAllowed === false)).toBe(true);
  });

  it('Tailscale answers and enrolls: the row is the Tailscale row of before, with the home network off', async () => {
    const { out, did } = await enroll({ mac: { reachable: [TAILNET, LAN] } }, { lan: HOME });
    if (!out.ok) throw new Error(out.message);
    expect(out.mac).toMatchObject({ lan: null, tailnet: '100.101.102.103', lanAllowed: false, lastPath: 'tailnet' });
    expect(did.requests).toEqual([`GET ${TAILNET}/api/auth/status`, 'POST https://api.aasc.work/v1/enroll/tickets', `POST ${TAILNET}/api/mobile/enroll`]);
  });

  it('Tailscale does not answer: the hint is dialled after it, and the Mac there enrolls', async () => {
    const { out, did } = await enroll({ mac: { reachable: [LAN] } }, { lan: HOME });
    if (!out.ok) throw new Error(out.message);
    expect(did.requests).toEqual([
      `GET ${TAILNET}/api/auth/status`, `GET ${LAN}/api/auth/status`, 'POST https://api.aasc.work/v1/enroll/tickets', `POST ${LAN}/api/mobile/enroll`,
    ]);
    expect(out.mac).toMatchObject({ lan: HOME, tailnet: null, lanAllowed: true, lastPath: 'lan' });
  });

  it('Tailscale does not answer and the hint is what Bonjour would have found: the same requests in the same order', async () => {
    const byBonjour = await enroll({ mac: { reachable: [LAN] }, discovery: bonjour(LAN) }, { lan: null });
    const hinted = await enroll({ mac: { reachable: [LAN] }, discovery: bonjour() }, { lan: HOME });
    expect(hinted.did).toEqual(byBonjour.did);
    expect(hinted.out.ok).toBe(true);
  });

  it('an address Bonjour also found is an address on this Wi-Fi: it is treated as before, hint or no hint', async () => {
    const opts: Parameters<typeof createHarness>[0] = { mac: { reachable: [LAN], strangers: [TAILNET] }, discovery: bonjour(LAN) };
    const today = await enroll(opts, { lan: null });
    const hinted = await enroll(opts, { lan: HOME });
    expect(hinted.did).toEqual(today.did);
    expect(hinted.out.ok).toBe(true); // passed over at the Tailscale address (NOT_THIS_MAC), enrolled at the found one
    expect(hinted.did.requests.filter((r) => r.endsWith('/api/mobile/enroll'))).toEqual([`POST ${TAILNET}/api/mobile/enroll`, `POST ${LAN}/api/mobile/enroll`]);
  });

  it('a user who moves on before the hint’s turn: the hint is never dialled', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [LAN] } });
    const stillHere = () => !t.mac.calls.some((c) => c.url.startsWith(TAILNET)); // gone once Tailscale has been tried
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], lan: HOME }, { phoneName: 'Pixel', proceed: stillHere });
    expect(out).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(t.mac.calls.some((c) => c.url.startsWith(LAN))).toBe(false);
    expectNothingSaved(t);
  });

  it('a relay answering at the hinted address gets a seal for the Mac’s own address: refused, nothing saved', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [TAILNET], relays: [LAN] } });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null, lan: HOME }, { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'invalid' });
    expect(message(out)).toContain('nothing was saved');
    expect(t.mac.enrolled()).toHaveLength(1); // the Mac did seal, for its own address
    expectNothingSaved(t);
  });

  it('a box at the hinted address that seals its own token is refused, nothing saved (C1)', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [], strangers: [LAN], strangerEnroll: { [LAN]: 'FORGE' } } });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null, lan: HOME }, { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'invalid' });
    expectNothingSaved(t);
  });

  it('another owner’s Mac at the hinted address (a café’s 192.168.1.20) is passed over, nothing saved', async () => {
    const { t, listed } = await signedIn({ mac: { reachable: [], strangers: [LAN] } });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], lan: HOME }, { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(enrollCalls(t).map((c) => new URL(c.url).origin)).toEqual([LAN]);
    expectNothingSaved(t);
  });

  it('an address of the wrong kind handed in as the home-network one is never dialled', async () => {
    const PUBLIC = 'http://8.8.8.8:3333';
    const { t, listed } = await signedIn({ mac: { reachable: [PUBLIC] } });
    const out = await enrollViaAccount(t.deps, [], { ...listed[0], tailnet: null, lan: '8.8.8.8' }, { phoneName: 'Pixel' });
    expect(out).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(t.mac.calls.some((c) => c.url.startsWith(PUBLIC))).toBe(false);
    expectNothingSaved(t);
  });

  it('names the home network before anything is asked of it, as for a Bonjour address', async () => {
    const { did } = await atHome('hinted', { reachable: [LAN] });
    expect(did.tried).toEqual([{ kind: 'lan', origin: LAN, encrypted: false }]);
    // By then only the probe has gone out: no ticket yet, and nothing posted to the address.
    expect(did.askedBeforeTheFirstTry).toEqual([`GET ${LAN}/api/auth/status`]);
  });

  // The proof that a hinted address gets no fewer checks than a Bonjour one: the same box at the same address,
  // found either way, sees the same requests in the same order and leaves the same things on the phone and the Mac.
  it.each<[string, FakeMacOptions, 'saved' | 'nothing saved']>([
    ['the Mac itself', { reachable: [LAN] }, 'saved'],
    ['a relay to the Mac', { reachable: [TAILNET], relays: [LAN] }, 'nothing saved'],
    ['a box that seals its own token', { reachable: [], strangers: [LAN], strangerEnroll: { [LAN]: 'FORGE' } }, 'nothing saved'],
    ['another owner’s Mac', { reachable: [], strangers: [LAN] }, 'nothing saved'],
    ['a box that answers 429', { reachable: [], strangers: [LAN], strangerEnroll: { [LAN]: 'RATE_LIMITED' } }, 'nothing saved'],
    ['the Mac with account sign-ins off', { reachable: [LAN], accountEnroll: false }, 'nothing saved'],
    ['nothing at all', { reachable: [] }, 'nothing saved'],
  ])('%s at the address: hinted or found by Bonjour, the same requests, the same checks, %s', async (_what, mac, end) => {
    const byBonjour = await atHome('bonjour', mac);
    const byHint = await atHome('hinted', mac);
    expect(byHint.did).toEqual(byBonjour.did);
    expect(byHint.out.ok).toBe(end === 'saved');
    if (end === 'nothing saved') expectNothingSaved(byHint.t);
    else expect(byHint.did.saved).toEqual([expect.objectContaining({ lan: HOME, lanAllowed: true, lastPath: 'lan', unconfirmed: true })]);
  });
});
