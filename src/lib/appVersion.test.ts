// appVersion.test.ts — the version and build stamp vite.config.ts bakes into the bundle.
import { afterEach, describe, expect, it, vi } from 'vitest';

type Globals = { __AASC_VERSION__?: unknown; __AASC_BUILD__?: unknown };

async function load(globals: Globals) {
  vi.resetModules();
  Object.assign(globalThis, globals);
  return import('./appVersion');
}

afterEach(() => {
  delete (globalThis as Globals).__AASC_VERSION__;
  delete (globalThis as Globals).__AASC_BUILD__;
});

describe('appVersion', () => {
  it('reads the version and build stamp the build set', async () => {
    const m = await load({ __AASC_VERSION__: '2.10.58', __AASC_BUILD__: { date: '2026-10-26T02:40:00.000Z', commit: 'f129192-dirty' } });
    expect(m.APP_VERSION).toBe('2.10.58');
    expect(m.APP_BUILD).toEqual({ date: '2026-10-26T02:40:00.000Z', commit: 'f129192-dirty' });
    expect(m.versionSummary()).toBe('AASC 2.10.58 (built 2026-10-26T02:40:00.000Z, f129192-dirty)');
  });

  it('says so when the build has no commit', async () => {
    const m = await load({ __AASC_VERSION__: '2.10.58', __AASC_BUILD__: { date: '2026-10-26T02:40:00.000Z', commit: null } });
    expect(m.versionSummary()).toBe('AASC 2.10.58 (built 2026-10-26T02:40:00.000Z, no commit)');
  });

  it('is null where the build set none (tests, harnesses), and never trusts a malformed stamp', async () => {
    const none = await load({});
    expect(none.APP_VERSION).toBeNull();
    expect(none.APP_BUILD).toBeNull();
    expect(none.versionSummary()).toBe('AASC (version unknown)');
    const bad = await load({ __AASC_VERSION__: '2.10.58', __AASC_BUILD__: { date: 5, commit: {} } });
    expect(bad.APP_BUILD).toBeNull();
    expect(bad.versionSummary()).toBe('AASC 2.10.58');
  });
});
