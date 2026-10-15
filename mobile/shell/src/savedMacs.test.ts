// AASC-17: the saved Macs list (Preferences) and the typed pairing code.
import { describe, expect, it } from 'vitest';
import { manualLink, normalizeCode } from './manualEntry';
import { allowedOrigins, loadMacs, MACS_KEY, parseSavedMac, saveMacs, withMac, withoutMac, type SavedMac } from './savedMacs';

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
