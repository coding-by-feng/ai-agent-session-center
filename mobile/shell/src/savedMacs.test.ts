// AASC-17: the saved Macs list (Preferences) and the typed pairing code.
import { describe, expect, it } from 'vitest';
import { manualLink, normalizeCode } from './manualEntry';
import {
  allowedOrigins, BACKEND_RELINK_KEY, clearBackendRelink, forgetBackendRelink, loadMacs, MACS_KEY, markBackendRelink, needsBackendRelink, parseSavedMac,
  RELINK_COOLDOWN_MS, saveMacs, withMac, withoutMac, type SavedMac,
} from './savedMacs';

const MAC: SavedMac = {
  id: '6f1c2a10-0000-4000-8000-000000000001', name: 'Kason-MBP', port: 3333, lan: '192.168.1.20', tailnet: '100.101.102.103',
  lanAllowed: false, backendDeviceId: null, status: 'active', confirmCode: null, phoneName: 'Pixel', lastPath: 'tailnet',
};

function memoryStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, get: async (k: string) => values.get(k) ?? null, set: async (k: string, v: string) => { values.set(k, v); } };
}

describe('saved Macs', () => {
  it('round-trips through Preferences', async () => {
    const store = memoryStore();
    await saveMacs(store, [MAC]);
    expect(await loadMacs(store)).toEqual([MAC]);
  });

  it.each([
    ['a public "home network"', { lan: '8.8.8.8' }],
    ['a tailnet address outside 100.64/10', { tailnet: '100.200.1.1', lan: null }],
    ['no address left', { lan: null, tailnet: null }],
    ['a path-like id', { id: '../../vault' }],
    ['a port out of range', { port: 70000 }],
    ['an unknown status', { status: 'admin' }],
    ['an empty name', { name: '‮\u0000' }],
  ])('drops an entry with %s', (_label, patch) => {
    expect(parseSavedMac({ ...MAC, ...patch })).toBeNull();
  });

  it('cleans what it keeps', () => {
    const parsed = parseSavedMac({ ...MAC, name: 'Kason‮-MBP\n', confirmCode: '123456', lastPath: 'relay', backendDeviceId: 'bad id' });
    expect(parsed).toMatchObject({ name: 'Kason-MBP', confirmCode: null, lastPath: null, backendDeviceId: null });
    expect(parseSavedMac({ ...MAC, status: 'pending', confirmCode: '123456' })?.confirmCode).toBe('123456');
  });

  it('survives garbage in storage', async () => {
    expect(await loadMacs(memoryStore({ [MACS_KEY]: '{not json' }))).toEqual([]);
    expect(await loadMacs(memoryStore({ [MACS_KEY]: '{"a":1}' }))).toEqual([]);
    expect(await loadMacs(memoryStore({ [MACS_KEY]: JSON.stringify([MAC, MAC]) }))).toEqual([MAC]);
  });

  it('adds, replaces and removes by id without touching the old list', () => {
    const list = [MAC];
    const renamed = withMac(list, { ...MAC, name: 'Renamed' });
    expect(renamed.map((m) => m.name)).toEqual(['Renamed']);
    expect(list[0].name).toBe('Kason-MBP');
    expect(withoutMac(renamed, MAC.id)).toEqual([]);
  });

  it('allows plain HTTP only to the paths each Mac may use', () => {
    expect(allowedOrigins([MAC])).toEqual(['http://100.101.102.103:3333']);
    expect(allowedOrigins([{ ...MAC, lanAllowed: true }])).toEqual(['http://192.168.1.20:3333', 'http://100.101.102.103:3333']);
  });
});

// AASC-60: a 403 from GET /v1/mac-paths means this Mac's backend token was made without mac-paths:read, so the next
// sign-in replaces it. A Mac whose backend keeps issuing push-only codes would then relink at every sign-in, and each
// relink revokes and re-creates a backend device: a Mac relinked within RELINK_COOLDOWN_MS is not marked again.
describe('the backend relink flag', () => {
  const OTHER = '6f1c2a10-0000-4000-8000-000000000002';
  const T0 = 1_760_000_000_000;

  it('is off until a 403 marks a Mac, and only that Mac', async () => {
    const store = memoryStore();
    expect(await needsBackendRelink(store, MAC.id)).toBe(false);
    await markBackendRelink(store, MAC.id, T0);
    expect(await needsBackendRelink(store, MAC.id)).toBe(true);
    expect(await needsBackendRelink(store, OTHER)).toBe(false);
  });

  it('is off again once the relink has linked', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    await clearBackendRelink(store, MAC.id, T0 + 1_000);
    expect(await needsBackendRelink(store, MAC.id)).toBe(false);
  });

  it('a 403 right after a relink does not mark it again', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    await clearBackendRelink(store, MAC.id, T0 + 1_000); // the relink linked
    await markBackendRelink(store, MAC.id, T0 + 2_000); // and the new token is refused too
    expect(await needsBackendRelink(store, MAC.id)).toBe(false);
    await markBackendRelink(store, MAC.id, T0 + 1_000 + RELINK_COOLDOWN_MS - 1); // a millisecond short of the end
    expect(await needsBackendRelink(store, MAC.id)).toBe(false);
  });

  it('marks again once the cooldown has passed', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    await clearBackendRelink(store, MAC.id, T0 + 1_000);
    await markBackendRelink(store, MAC.id, T0 + 1_000 + RELINK_COOLDOWN_MS);
    expect(await needsBackendRelink(store, MAC.id)).toBe(true);
    await clearBackendRelink(store, MAC.id, T0 + 2_000 + RELINK_COOLDOWN_MS); // and that relink starts its own cooldown
    await markBackendRelink(store, MAC.id, T0 + 3_000 + RELINK_COOLDOWN_MS);
    expect(await needsBackendRelink(store, MAC.id)).toBe(false);
  });

  it('is a week', () => {
    expect(RELINK_COOLDOWN_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('a first link starts no cooldown: a phone linked push-only can relink as soon as the backend is upgraded', async () => {
    const store = memoryStore();
    await clearBackendRelink(store, MAC.id, T0); // a link nobody had asked to redo
    await markBackendRelink(store, MAC.id, T0 + 1);
    expect(await needsBackendRelink(store, MAC.id)).toBe(true);
  });

  it('keeps each Mac’s cooldown to itself', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    await clearBackendRelink(store, MAC.id, T0 + 1_000);
    await markBackendRelink(store, OTHER, T0 + 2_000);
    expect(await needsBackendRelink(store, OTHER)).toBe(true);
    expect(await needsBackendRelink(store, MAC.id)).toBe(false);
    await clearBackendRelink(store, OTHER, T0 + 3_000);
    expect(await needsBackendRelink(store, OTHER)).toBe(false);
  });

  it('marking a marked Mac again changes nothing', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    const once = store.values.get(BACKEND_RELINK_KEY);
    await markBackendRelink(store, MAC.id, T0 + 5_000);
    expect(store.values.get(BACKEND_RELINK_KEY)).toBe(once);
  });

  it('a clock set back does not hold the cooldown for ever', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0 + 365 * 24 * 60 * 60 * 1000); // the phone's clock was a year ahead
    await clearBackendRelink(store, MAC.id, T0 + 365 * 24 * 60 * 60 * 1000);
    await markBackendRelink(store, MAC.id, T0); // and has been corrected since
    expect(await needsBackendRelink(store, MAC.id)).toBe(true);
  });

  it('forgets a cooldown that has ended, and keeps at most 32 Macs', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    await clearBackendRelink(store, MAC.id, T0 + 1_000);
    await markBackendRelink(store, OTHER, T0 + 1_000 + RELINK_COOLDOWN_MS);
    expect(JSON.parse(store.values.get(BACKEND_RELINK_KEY)!)).toHaveLength(1);
    const ids = Array.from({ length: 40 }, (_, i) => `mac-id-${String(i).padStart(4, '0')}`);
    for (const id of ids) await markBackendRelink(store, id, T0);
    expect(JSON.parse(store.values.get(BACKEND_RELINK_KEY)!)).toHaveLength(32);
    expect(await needsBackendRelink(store, ids[0])).toBe(false); // the oldest went
    expect(await needsBackendRelink(store, ids[39])).toBe(true);
  });

  it('survives garbage in storage, and writes over it', async () => {
    for (const bad of ['{not json', '{"a":1}', '"x"', '[1,"a",null,{"id":5},{"id":"../../vault","marked":true},{"id":"mac-id-0001","marked":"yes"}]']) {
      const store = memoryStore({ [BACKEND_RELINK_KEY]: bad });
      expect(await needsBackendRelink(store, MAC.id)).toBe(false);
      expect(await needsBackendRelink(store, 'mac-id-0001')).toBe(false);
      expect(await needsBackendRelink(store, '../../vault')).toBe(false);
      await markBackendRelink(store, MAC.id, T0);
      expect(await needsBackendRelink(store, MAC.id)).toBe(true);
    }
  });

  it('forgets a removed Mac’s mark and cooldown, and only its own', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    await markBackendRelink(store, OTHER, T0);
    await clearBackendRelink(store, OTHER, T0 + 1_000);
    await forgetBackendRelink(store, MAC.id);
    expect(await needsBackendRelink(store, MAC.id)).toBe(false);
    expect(JSON.parse(store.values.get(BACKEND_RELINK_KEY)!)).toEqual([{ id: OTHER, marked: false, relinkedAt: T0 + 1_000 }]);
    await markBackendRelink(store, MAC.id, T0 + 2_000); // nothing of the old record is left to hold it off
    expect(await needsBackendRelink(store, MAC.id)).toBe(true);
    await forgetBackendRelink(store, OTHER);
    await forgetBackendRelink(store, MAC.id);
    expect(JSON.parse(store.values.get(BACKEND_RELINK_KEY)!)).toEqual([]);
  });

  it('forgetting a Mac with no record writes nothing', async () => {
    const store = memoryStore();
    await forgetBackendRelink(store, MAC.id);
    expect(store.values.has(BACKEND_RELINK_KEY)).toBe(false);
    await markBackendRelink(store, OTHER, T0);
    const before = store.values.get(BACKEND_RELINK_KEY);
    await forgetBackendRelink(store, MAC.id);
    expect(store.values.get(BACKEND_RELINK_KEY)).toBe(before);
  });

  it('keeps only ids and times in Preferences', async () => {
    const store = memoryStore();
    await markBackendRelink(store, MAC.id, T0);
    await clearBackendRelink(store, MAC.id, T0 + 1_000);
    expect(JSON.parse(store.values.get(BACKEND_RELINK_KEY)!)).toEqual([{ id: MAC.id, marked: false, relinkedAt: T0 + 1_000 }]);
  });
});

describe('typed pairing code', () => {
  it('reads the code the way the Mac shows it', () => {
    expect(normalizeCode(' k7q2m-9xpzt ')).toBe('K7Q2M9XPZT');
    const result = manualLink({ address: '100.101.102.103', port: '3333', code: 'K7Q2M-9XPZT' });
    expect(result.ok && result.link).toMatchObject({ tailnet: '100.101.102.103', lan: null, port: 3333, macCode: 'K7Q2M9XPZT' });
    const lan = manualLink({ address: '192.168.1.20', port: '3333', code: 'K7Q2M9XPZT' });
    expect(lan.ok && lan.link.lan).toBe('192.168.1.20');
  });

  it.each([
    [{ address: 'evil.example', port: '3333', code: 'K7Q2M9XPZT' }, 'address'],
    [{ address: '8.8.8.8', port: '3333', code: 'K7Q2M9XPZT' }, 'address'],
    [{ address: '100.101.102.103', port: '0', code: 'K7Q2M9XPZT' }, 'port'],
    [{ address: '100.101.102.103', port: '3333', code: 'K7Q2M9XPZ0' }, 'code'],
    [{ address: '100.101.102.103', port: '3333&mc=AAAAAAAAAA', code: 'K7Q2M9XPZT' }, 'port'],
  ])('points at the wrong field of %o', (entry, field) => {
    const result = manualLink(entry);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.field).toBe(field);
  });
});
