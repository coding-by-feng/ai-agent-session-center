// @vitest-environment jsdom
// AASC-60: the last gate before the phone dials an address it learned from AASC Cloud. findViaCloud hands back only
// addresses it has checked, but the row is changed and a request goes out here, so only a Tailscale address passes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findViaCloud } from './cloudFind';
import { writeBackendCredential } from './savedMacs';
import { signInAndOpen } from './shellFlows';
import { createHarness, seedMac, STUDIO } from './testing/shellHarness';

vi.mock('./cloudFind', () => ({ findViaCloud: vi.fn() }));

afterEach(() => {
  vi.mocked(findViaCloud).mockReset();
  document.body.replaceChildren();
});

/** A Tailscale-only row with a backend token, whose Mac answers at `reachable` only. */
async function phone(reachable: string[]) {
  const t = createHarness({ mac: { reachable } });
  await seedMac(t, STUDIO);
  await writeBackendCredential(t.deps.vault, STUDIO.id, t.mac.seedBackendDevice());
  return t;
}

describe('the address a cloud lookup returns', () => {
  it.each([
    ['a public address', '8.8.8.8'],
    ['a home-network address', '192.168.1.9'],
    ['just outside Tailscale’s range', '100.63.255.255'],
    ['a padded octet the URL parser would read as 100.52.1.1', '100.064.001.001'],
    ['a name', 'evil.example'],
    ['an address with a port', '100.101.102.103:4000'],
  ])('is never dialled when it is %s', async (_why, host) => {
    vi.mocked(findViaCloud).mockResolvedValue(host);
    const t = await phone([]);
    const out = await signInAndOpen(t.deps, [STUDIO], STUDIO, '/');
    expect(out.kind).toBe('offline');
    const dialled = t.mac.calls.filter((c) => c.url.startsWith('http://') && !c.url.startsWith('http://100.88.1.7:3333/'));
    expect(dialled).toEqual([]);
    expect(t.cookies).toEqual([]);
  });

  it('is dialled when it is a Tailscale address', async () => {
    vi.mocked(findViaCloud).mockResolvedValue('100.88.1.9');
    const t = await phone(['http://100.88.1.9:3333']);
    const out = await signInAndOpen(t.deps, [STUDIO], STUDIO, '/');
    expect(out).toMatchObject({ kind: 'navigate', url: 'http://100.88.1.9:3333/', mac: { tailnet: '100.88.1.9', lastPath: 'tailnet' } });
  });

  it('is not dialled once the user has moved on', async () => {
    vi.mocked(findViaCloud).mockResolvedValue('100.88.1.9');
    const t = await phone(['http://100.88.1.9:3333']);
    const out = await signInAndOpen(t.deps, [STUDIO], STUDIO, '/', undefined, { proceed: () => false });
    expect(out.kind).toBe('offline');
    expect(t.mac.calls.filter((c) => c.url.startsWith('http://100.88.1.9'))).toEqual([]);
  });
});
