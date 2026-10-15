// @vitest-environment jsdom
// AASC-17: signing in again when the Mac UI's session lapsed (?reauth=1&back=…).
import { afterEach, describe, expect, it } from 'vitest';
import { LAST_MAC_KEY } from './savedMacs';
import { click, createHarness, heading, KASON_MBP, seedMac, STUDIO, TAILNET, until, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

async function returning(search: string, opts: HarnessOptions = {}) {
  const t = createHarness({ search, ...opts, store: { [LAST_MAC_KEY]: KASON_MBP.id, ...opts.store } });
  await seedMac(t, KASON_MBP);
  await seedMac(t, STUDIO);
  return t;
}

describe('Signing in again', () => {
  it('signs in on the Mac shown last and returns to the path it asked for', async () => {
    const t = await returning('?reauth=1&back=%2Fqueue%3Fsession%3Dabc');
    // Hold the first probe so the sign-in screen can be seen.
    let release = () => {};
    const held = new Promise<void>((r) => { release = r; });
    const request = t.deps.requester.request;
    t.deps.requester.request = async (req) => { await held; return request(req); };
    const started = t.app.start();
    await until(t.root, () => heading(t.root) === 'Signing in to Kason-MBP');
    expect(t.root.querySelector('[role="status"]')?.textContent).toContain('Trying Tailscale (100.101.102.103:3333)');
    release();
    await started;
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/queue?session=abc`]);
    expect(t.cookies.map((c) => c.origin)).toEqual([TAILNET]);
  });

  it.each([
    ['an absolute URL', '?reauth=1&back=https%3A%2F%2Fevil.example%2F'],
    ['a protocol-relative URL', '?reauth=1&back=%2F%2Fevil.example'],
    ['a backslash trick', '?reauth=1&back=%2F%5Cevil.example'],
  ])('never leaves the paired Mac for %s', async (_label, search) => {
    const t = await returning(search);
    await t.app.start();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
  });

  it('keeps the return path through Can’t reach and Try again', async () => {
    const t = await returning('?reauth=1&back=%2Fqueue', { mac: { reachable: [] } });
    await t.app.start();
    expect(heading(t.root)).toBe('Can’t reach Kason-MBP');
    t.mac.setReachable([TAILNET]);
    click(t.root, 'Try again');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/queue`]);
  });

  it('goes to the approval screen when the Mac still waits for approval', async () => {
    const t = createHarness({ search: '?reauth=1&back=%2F', store: { [LAST_MAC_KEY]: KASON_MBP.id } });
    await seedMac(t, { ...KASON_MBP, status: 'pending', confirmCode: '123456' }, 'pending');
    await t.app.start();
    expect(heading(t.root)).toBe('Approve on your Mac');
  });

  it('goes to pairing when the Mac revoked this phone meanwhile', async () => {
    const t = createHarness({ search: '?reauth=1&back=%2Fqueue', store: { [LAST_MAC_KEY]: KASON_MBP.id } });
    await seedMac(t, KASON_MBP, 'revoked');
    await t.app.start();
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    expect(t.root.textContent).toContain('removed this phone');
    expect(t.navigations).toEqual([]);
  });

  it('shows the list when it can’t tell which Mac asked', async () => {
    const t = createHarness({ search: '?reauth=1&back=%2F' });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    expect(heading(t.root)).toBe('Your Macs');
  });
});
