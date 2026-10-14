// pushRegistration.test.ts — AASC-19: permission prompt, backend registration, unregister.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  createPushRegistrar, registrationBody, classifyRegistration, pushStateNotice, removePushTarget,
  APP_ID, PUSH_ASKED_KEY,
  type PushPlatform, type PushPermission, type KeyValueStore, type BackendCredential, type PushSetupState,
} from './pushRegistration';
import type { HttpRequest, HttpRequester } from './http';

const APNS = 'a1'.repeat(32);
const APNS_ROTATED = 'b2'.repeat(32);
const FCM = 'fcm-token:APA91b_xyz-123';
const CRED: BackendCredential = { host: 'api.aasc.work', deviceId: 'be-1', token: 'B'.repeat(43) };
const CRED_2: BackendCredential = { host: 'api.aasc.work', deviceId: 'be-2', token: 'C'.repeat(43) };
const TARGET_URL = 'https://api.aasc.work/v1/push/targets/self';

function fakePlatform(opts: { os?: 'ios' | 'android'; permission?: PushPermission; answer?: PushPermission; token?: string | null } = {}) {
  let permission: PushPermission = opts.permission ?? 'prompt';
  const tokenListeners = new Set<(t: string) => void>();
  const errorListeners = new Set<() => void>();
  const platform: PushPlatform & { emit(t: string): void; fail(): void } = {
    os: opts.os ?? 'ios',
    checkPermission: vi.fn(async () => permission),
    requestPermission: vi.fn(async () => {
      permission = opts.answer ?? 'granted';
      return permission;
    }),
    register: vi.fn(async () => {
      const token = opts.token === undefined ? APNS : opts.token;
      if (token) tokenListeners.forEach((cb) => cb(token));
    }),
    unregister: vi.fn(async () => {}),
    onToken(cb) {
      tokenListeners.add(cb);
      return () => tokenListeners.delete(cb);
    },
    onRegistrationError(cb) {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    environment: () => 'sandbox',
    emit: (t) => tokenListeners.forEach((cb) => cb(t)),
    fail: () => errorListeners.forEach((cb) => cb()),
  };
  return platform;
}

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
}

type Answer = { status: number; data: unknown } | Error;
function fakeHttp(answer: Answer | ((req: HttpRequest) => Answer) = { status: 200, data: { success: true, data: { targetId: 't-1' } } }) {
  const calls: HttpRequest[] = [];
  const http: HttpRequester & { calls: HttpRequest[] } = {
    calls,
    async request(req) {
      calls.push(req);
      const a = typeof answer === 'function' ? answer(req) : answer;
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return http;
}

function setup(opts: Parameters<typeof fakePlatform>[0] & { creds?: BackendCredential[]; paired?: boolean; http?: ReturnType<typeof fakeHttp> } = {}) {
  const platform = fakePlatform(opts);
  const store = memoryStore();
  const http = opts.http ?? fakeHttp();
  const states: PushSetupState[] = [];
  const revoked: string[] = [];
  const registrar = createPushRegistrar({
    platform, store, http,
    pairing: () => ({ paired: opts.paired ?? true, backend: opts.creds ?? [CRED] }),
    onState: (s) => states.push(s),
    onRevoked: (id) => revoked.push(id),
  });
  return { platform, store, http, states, revoked, registrar };
}

describe('when to ask', () => {
  it('does nothing before a Mac is paired', async () => {
    const { platform, registrar } = setup({ paired: false });
    expect(await registrar.start('launch')).toEqual({ state: 'unpaired' });
    expect(platform.checkPermission).not.toHaveBeenCalled();
  });

  it('never asks when the pairing carried no backend code', async () => {
    const { platform, registrar } = setup({ creds: [] });
    expect(await registrar.start('paired')).toEqual({ state: 'backend-not-configured' });
    expect(platform.requestPermission).not.toHaveBeenCalled();
    expect(pushStateNotice({ state: 'backend-not-configured' })?.text).toMatch(/AASC cloud/);
  });

  it('never prompts at launch', async () => {
    const { platform, registrar } = setup();
    expect(await registrar.start('launch')).toEqual({ state: 'not-asked' });
    expect(platform.requestPermission).not.toHaveBeenCalled();
    expect(platform.register).not.toHaveBeenCalled();
    expect(pushStateNotice({ state: 'not-asked' })?.action).toBe('enable');
  });

  it('asks once after pairing, and again only from settings', async () => {
    const first = setup({ answer: 'prompt' }); // dismissed without answering
    expect(await first.registrar.start('paired')).toEqual({ state: 'not-asked' });
    expect(first.store.data.get(PUSH_ASKED_KEY)).toBe('1');
    expect(await first.registrar.start('paired')).toEqual({ state: 'not-asked' });
    expect(first.platform.requestPermission).toHaveBeenCalledTimes(1);
    await first.registrar.start('settings');
    expect(first.platform.requestPermission).toHaveBeenCalledTimes(2);
  });

  it('reports a denial so the UI can point to Settings', async () => {
    const asked = setup({ answer: 'denied' });
    expect(await asked.registrar.start('paired')).toEqual({ state: 'denied' });
    const already = setup({ permission: 'denied' });
    expect(await already.registrar.start('settings')).toEqual({ state: 'denied' });
    expect(already.platform.requestPermission).not.toHaveBeenCalled();
    expect(pushStateNotice({ state: 'denied' })?.action).toBe('open-settings');
  });
});

describe('registering with the backend', () => {
  it('sends the token after the prompt is granted', async () => {
    const { registrar, http, states } = setup();
    await registrar.start('paired');
    expect(await registrar.settled()).toEqual({ state: 'registered' });
    expect(states.map((s) => s.state)).toEqual(['waiting-for-token', 'registered']);
    expect(http.calls).toEqual([{
      method: 'PUT',
      url: TARGET_URL,
      headers: { Authorization: `Bearer ${CRED.token}`, 'Content-Type': 'application/json' },
      body: { provider: 'apns', token: APNS, environment: 'sandbox', appId: APP_ID },
    }]);
  });

  it('re-sends on every launch without asking', async () => {
    const { registrar, platform, http } = setup({ permission: 'granted' });
    await registrar.start('launch');
    await registrar.settled();
    expect(platform.requestPermission).not.toHaveBeenCalled();
    expect(http.calls).toHaveLength(1);
  });

  it('re-sends a rotated token at once, and not the same one twice', async () => {
    const { registrar, platform, http } = setup({ permission: 'granted' });
    await registrar.start('launch');
    await registrar.settled();
    platform.emit(APNS);
    await registrar.settled();
    expect(http.calls).toHaveLength(1);
    platform.emit(APNS_ROTATED);
    await registrar.settled();
    expect(http.calls).toHaveLength(2);
    expect((http.calls[1].body as { token: string }).token).toBe(APNS_ROTATED);
  });

  it('registers an Android FCM token as production', async () => {
    const { registrar, http } = setup({ os: 'android', permission: 'granted', token: FCM });
    await registrar.start('launch');
    await registrar.settled();
    expect(http.calls[0].body).toEqual({ provider: 'fcm', token: FCM, environment: 'production', appId: APP_ID });
  });

  it('refuses to send a token the backend would reject', async () => {
    const { registrar, http } = setup({ permission: 'granted', token: 'not-hex' });
    await registrar.start('launch');
    expect(await registrar.settled()).toEqual({ state: 'retry', status: null });
    expect(http.calls).toHaveLength(0);
    expect(registrationBody('ios', 'ab', 'production')).toBeNull();
    expect(registrationBody('android', 'has space', 'production')).toBeNull();
  });

  it('registers with every backend pairing and drops a revoked one', async () => {
    const http = fakeHttp((req) => (req.headers?.Authorization?.includes('C') ? { status: 401, data: { success: false, error: { code: 'unauthorized' } } } : { status: 200, data: { data: { targetId: 't' } } }));
    const { registrar, revoked } = setup({ permission: 'granted', creds: [CRED, CRED_2], http });
    await registrar.start('launch');
    expect(await registrar.settled()).toEqual({ state: 'registered' });
    expect(revoked).toEqual(['be-2']);
  });

  it('never sends to a stored host outside aasc.work', async () => {
    const { registrar, http } = setup({ permission: 'granted', creds: [{ ...CRED, host: 'evil.example' }] });
    await registrar.start('launch');
    expect(await registrar.settled()).toEqual({ state: 'retry', status: null });
    expect(http.calls).toHaveLength(0);
  });

  it('turns a registration error into a retry state', async () => {
    const { registrar, platform } = setup({ permission: 'granted', token: null });
    await registrar.start('launch');
    platform.fail();
    expect(registrar.state()).toEqual({ state: 'retry', status: null });
  });

  it('never puts a token in a state, a notice or a URL', async () => {
    const { registrar, http, states } = setup({ permission: 'granted' });
    await registrar.start('launch');
    await registrar.settled();
    const visible = JSON.stringify([states, states.map(pushStateNotice), http.calls.map((c) => c.url)]);
    expect(visible).not.toContain(APNS);
    expect(visible).not.toContain(CRED.token);
  });
});

describe('classifyRegistration', () => {
  it.each([
    [{ status: 200, data: { success: true, data: { targetId: 'x' } } }, { state: 'registered' }],
    [{ status: 200, data: {} }, { state: 'retry', status: 200 }],
    [{ status: 503, data: { success: false, error: { code: 'push_unconfigured' } } }, { state: 'push-unconfigured' }],
    [{ status: 400, data: { success: false, error: { code: 'push_app_not_allowed' } } }, { state: 'app-not-allowed' }],
    [{ status: 401, data: { success: false, error: { code: 'unauthorized' } } }, { state: 'revoked' }],
    [{ status: 429, data: {} }, { state: 'retry', status: 429 }],
    [{ status: 500, data: {} }, { state: 'retry', status: 500 }],
  ])('maps %j', (res, state) => {
    expect(classifyRegistration(res)).toEqual(state);
  });

  it('has a notice (or deliberately none) for every state', () => {
    const states: PushSetupState[] = [
      { state: 'unpaired' }, { state: 'backend-not-configured' }, { state: 'not-asked' }, { state: 'denied' },
      { state: 'waiting-for-token' }, { state: 'registered' }, { state: 'push-unconfigured' },
      { state: 'app-not-allowed' }, { state: 'revoked' }, { state: 'retry', status: 500 },
    ];
    expect(states.map((s) => pushStateNotice(s)?.action ?? null)).toEqual([
      null, null, 'enable', 'open-settings', null, null, null, null, 're-pair', 'retry',
    ]);
  });
});

describe('unregistering', () => {
  it('deletes the target with no body, then stops push when no Mac is left', async () => {
    const { registrar, platform, http, states } = setup({ permission: 'granted' });
    expect(await registrar.unregister(CRED, { lastPairing: true })).toBe('deleted');
    expect(http.calls).toEqual([{ method: 'DELETE', url: TARGET_URL, headers: { Authorization: `Bearer ${CRED.token}` } }]);
    expect(platform.unregister).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ state: 'unpaired' });
  });

  it('keeps push on while another Mac is paired', async () => {
    const { registrar, platform } = setup();
    await registrar.unregister(CRED, { lastPairing: false });
    expect(platform.unregister).not.toHaveBeenCalled();
  });

  it('treats a revoked or unknown target as already gone, and offline as failed', async () => {
    expect(await removePushTarget(fakeHttp({ status: 401, data: {} }), CRED)).toBe('gone');
    expect(await removePushTarget(fakeHttp({ status: 404, data: {} }), CRED)).toBe('gone');
    expect(await removePushTarget(fakeHttp(new Error('offline')), CRED)).toBe('failed');
    expect(await removePushTarget(fakeHttp({ status: 503, data: {} }), CRED)).toBe('failed');
  });

  it('stops listening when disposed', async () => {
    const { registrar, platform, http } = setup({ permission: 'granted' });
    registrar.dispose();
    platform.emit(APNS);
    await registrar.settled();
    expect(http.calls).toHaveLength(0);
  });
});

describe('app identity', () => {
  it('registers under the same app id the Capacitor config declares', () => {
    const config = readFileSync(resolve(__dirname, '../../capacitor.config.ts'), 'utf8');
    expect(config).toContain(`appId: '${APP_ID}'`);
  });
});
