import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createGoogleSignIn, SIGN_IN_PENDING_MS } from '../server/cloud/googleSignIn.js';

const RETURN = 'http://127.0.0.1:3334/api/resources/cloud/google/callback';
const CODE = 'C'.repeat(22);
function harness() {
  let time = 1_000_000;
  const connect = vi.fn(async (input: { backendUrl: string; pairingCode: string; deviceName: string; verifier?: string }) => ({
    backendOrigin: input.backendUrl,
    accountId: '00000000-0000-4000-8000-000000000001',
    deviceId: '00000000-0000-4000-8000-000000000002',
    deviceName: input.deviceName,
    generation: 1,
  }));
  const logs: string[] = [];
  const signIn = createGoogleSignIn({
    connect,
    now: () => time,
    log: (m) => logs.push(m),
  });
  return { signIn, connect, logs, advance: (ms: number) => (time += ms) };
}
const begin = (h: ReturnType<typeof harness>) =>
  new URL(h.signIn.begin({ backendUrl: 'https://api.aasc.work', deviceName: 'kason-mac', returnUrl: RETURN }).url);

describe('Google sign-in on the Mac', () => {
  it('begin builds the backend start URL with c=SHA256(v), s and the return URL', async () => {
    const h = harness();
    const url = begin(h);
    expect(url.origin + url.pathname).toBe('https://api.aasc.work/v1/auth/google/start');
    const c = url.searchParams.get('c')!;
    const s = url.searchParams.get('s')!;
    expect(c).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('return')).toBe(RETURN);
    expect(h.signIn.pending()).toBe(true);
    await expect(h.signIn.finish({ code: CODE, state: s })).resolves.toBe('connected');
    const sent = h.connect.mock.calls[0]![0];
    expect(sent).toMatchObject({ backendUrl: 'https://api.aasc.work', pairingCode: CODE, deviceName: 'kason-mac' });
    expect(createHash('sha256').update(sent.verifier!).digest('base64url')).toBe(c);
  });

  it('refuses a bad backend URL, device name or return URL', () => {
    const h = harness();
    expect(() => h.signIn.begin({ backendUrl: 'ftp://x', deviceName: 'kason-mac', returnUrl: RETURN })).toThrow();
    expect(() => h.signIn.begin({ backendUrl: 'https://api.aasc.work', deviceName: '', returnUrl: RETURN })).toThrow();
    expect(() =>
      h.signIn.begin({ backendUrl: 'https://api.aasc.work', deviceName: 'm', returnUrl: 'https://evil.example/cb' }),
    ).toThrow();
    expect(() =>
      h.signIn.begin({
        backendUrl: 'https://api.aasc.work',
        deviceName: 'm',
        returnUrl: 'http://localhost:3334/api/resources/cloud/google/callback',
      }),
    ).toThrow();
    expect(h.signIn.pending()).toBe(false);
  });

  it('a callback with no pending sign-in does nothing', async () => {
    const h = harness();
    await expect(h.signIn.finish({ code: CODE, state: 's'.repeat(43) })).resolves.toBe('no-pending');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('a callback with a different state does nothing, and cannot cancel the real sign-in', async () => {
    const h = harness();
    const s = begin(h).searchParams.get('s')!;
    await expect(h.signIn.finish({ code: CODE, state: 'x'.repeat(43) })).resolves.toBe('state-mismatch');
    await expect(h.signIn.finish({})).resolves.toBe('state-mismatch');
    expect(h.connect).not.toHaveBeenCalled();
    await expect(h.signIn.finish({ code: CODE, state: s })).resolves.toBe('connected');
    await expect(h.signIn.finish({ code: CODE, state: s })).resolves.toBe('no-pending');
  });

  it('an expired pending sign-in does nothing', async () => {
    const h = harness();
    const s = begin(h).searchParams.get('s')!;
    h.advance(SIGN_IN_PENDING_MS);
    await expect(h.signIn.finish({ code: CODE, state: s })).resolves.toBe('expired');
    expect(h.connect).not.toHaveBeenCalled();
  });

  it('a second begin replaces the first, and cancel drops it', async () => {
    const h = harness();
    const first = begin(h).searchParams.get('s')!;
    const second = begin(h).searchParams.get('s')!;
    await expect(h.signIn.finish({ code: CODE, state: first })).resolves.toBe('state-mismatch');
    expect(h.signIn.pending()).toBe(true);
    begin(h);
    h.signIn.cancel();
    expect(h.signIn.pending()).toBe(false);
    expect(second).not.toBe(first);
  });

  it('a malformed code or a failing pair reports failed', async () => {
    const h = harness();
    let s = begin(h).searchParams.get('s')!;
    await expect(h.signIn.finish({ code: 'short', state: s })).resolves.toBe('failed');
    s = begin(h).searchParams.get('s')!;
    h.connect.mockRejectedValueOnce(new Error('Invalid pairing code'));
    await expect(h.signIn.finish({ code: CODE, state: s })).resolves.toBe('failed');
  });

  it('the code, state and verifier never reach the log', async () => {
    const h = harness();
    const s = begin(h).searchParams.get('s')!;
    await h.signIn.finish({ code: CODE, state: s });
    const verifier = h.connect.mock.calls[0]![0].verifier!;
    for (const line of h.logs) {
      expect(line).not.toContain(CODE);
      expect(line).not.toContain(s);
      expect(line).not.toContain(verifier);
    }
  });
});
