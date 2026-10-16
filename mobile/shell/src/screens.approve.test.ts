// @vitest-environment jsdom
// AASC-17: "Approve on your Mac" — the code, the wait, and how it ends.
import { afterEach, describe, expect, it } from 'vitest';
import { loadMacs, readBackendCredential, readMacCredentials } from './savedMacs';
import { SESSION_COOKIE_MAX_AGE } from './shellFlows';
import { click, createHarness, heading, LAN, LEGACY_LINK, pairUntilApproval, TAILNET, until } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

describe('Approve on your Mac', () => {
  it('shows the 6-digit code to compare, read out digit by digit', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    const code = t.root.querySelector('.code');
    expect(code?.textContent).toBe('482 913');
    expect(code?.getAttribute('aria-label')).toBe('Code 4 8 2 9 1 3');
    expect(t.root.textContent).toContain('Kason-MBP asks: Allow “Android phone”?');
    expect(t.root.querySelector('[role="status"]')?.textContent).toContain('Waiting for Kason-MBP');
  });

  it('opens the Mac once it allows the phone: cookie first, then the guarded address', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect(t.cookies).toHaveLength(1);
    expect(t.cookies[0]).toMatchObject({ origin: TAILNET, maxAgeSeconds: SESSION_COOKIE_MAX_AGE });
    expect(t.allowed.at(-1)).toEqual([TAILNET]); // the home network wasn't allowed
    const [mac] = await loadMacs(t.deps.store);
    expect(mac).toMatchObject({ name: 'Kason-MBP', status: 'active', confirmCode: null, lastPath: 'tailnet', backendDeviceId: 'mac-dev-1' });
    expect(await readMacCredentials(t.deps.vault, mac.id)).not.toBeNull();
    expect(await readBackendCredential(t.deps.vault, mac.id)).toMatchObject({ host: 'api.aasc.work' });
  });

  it('gets its backend code from the Mac once allowed, over its own session: never from the QR (AASC-52)', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    // Nothing reached the backend while the phone waited for approval.
    expect(t.mac.calls.filter((c) => c.url.startsWith('https://'))).toEqual([]);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
    const ask = t.mac.calls.find((c) => c.url === `${TAILNET}/api/mobile/backend-code`);
    expect(ask?.method).toBe('POST');
    expect(ask?.headers.Authorization).toBe(`Bearer ${t.cookies[0].token}`);
    const redeem = t.mac.calls.find((c) => c.url === 'https://api.aasc.work/v1/devices/pair');
    expect(redeem?.body).toEqual({ code: t.mac.backendCodes()[0], name: 'Android phone' });
    // Asked once, after the session and before the Mac's page loads.
    const order = t.mac.calls.map((c) => c.url);
    expect(order.indexOf(`${TAILNET}/api/mobile/backend-code`)).toBeGreaterThan(order.lastIndexOf(`${TAILNET}/api/mobile/session`));
  });

  it('ignores the backend code an old QR carries: it redeems only what the Mac issues after approval', async () => {
    const t = createHarness();
    await pairUntilApproval(t, LEGACY_LINK);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
    const redeemed = t.mac.calls.filter((c) => c.url === 'https://api.aasc.work/v1/devices/pair').map((c) => (c.body as { code: string }).code);
    expect(redeemed).toEqual([t.mac.backendCodes()[0]]);
    expect(redeemed).not.toContain('abcdefghijklmnopqrstuv');
  });

  it('allows the home network when it was turned on at pairing, and tries it first', async () => {
    const t = createHarness({ mac: { reachable: [TAILNET, LAN], approveAfter: 0 } });
    await t.app.start();
    const link = 'https://aasc.work/pair#v=2&name=Kason-MBP&lan=192.168.1.20&ts=100.101.102.103&p=3333&mc=K7Q2M9XPZT';
    t.openLink(link);
    const lan = t.root.querySelector<HTMLInputElement>('#allow-lan');
    lan!.checked = true;
    lan!.dispatchEvent(new Event('change', { bubbles: true }));
    click(t.root, 'Pair');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${LAN}/`]);
    expect(t.allowed.at(-1)).toEqual([LAN, TAILNET]);
  });

  it('says the Mac refused, and forgets the pairing', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    t.mac.deny();
    await until(t.root, () => heading(t.root) === 'Not allowed');
    expect(t.root.textContent).toContain('Kason-MBP refused this phone, or the request expired');
    expect(t.vault.size).toBe(0);
    expect(await loadMacs(t.deps.store)).toEqual([]);
    click(t.root, 'Pair again');
    expect(heading(t.root)).toBe('Pair with a Mac');
  });

  it('keeps waiting while the Mac is out of reach, and says so', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    t.mac.setReachable([]);
    await until(t.root, () => t.root.textContent?.includes('Can’t reach Kason-MBP right now') ?? false);
    t.mac.setReachable([TAILNET]);
    await until(t.root, () => t.root.textContent?.includes('Waiting for Kason-MBP') ?? false);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
  });

  it('stops asking after a while and offers to check again', async () => {
    const t = createHarness({ timing: { pollMs: 5, pollMaxMs: 20 } });
    await pairUntilApproval(t);
    await until(t.root, () => t.root.textContent?.includes('Still waiting') ?? false);
    const checks = t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/session')).length;
    await new Promise((r) => setTimeout(r, 30));
    expect(t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/session'))).toHaveLength(checks);
    t.mac.approve();
    click(t.root, 'Check again');
    await until(t.root, () => t.navigations.length > 0);
  });

  it('cancels: the Mac drops the phone and the phone forgets it', async () => {
    const t = createHarness();
    await pairUntilApproval(t);
    click(t.root, 'Cancel pairing');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    expect(t.root.textContent).toContain('Pairing cancelled.');
    expect([...t.mac.devices.values()].map((d) => d.status)).toEqual(['revoked']);
    expect(t.mac.pushTargetsRemoved()).toBe(0); // a phone waiting for approval holds no backend device (AASC-52)
    expect(t.vault.size).toBe(0);
    expect(await loadMacs(t.deps.store)).toEqual([]);
  });

  it('resumes the wait for a Mac still pending after a restart', async () => {
    const first = createHarness();
    await pairUntilApproval(first);
    first.app.dispose();
    document.body.replaceChildren();
    const t = createHarness({ store: Object.fromEntries(first.store), vault: Object.fromEntries(first.vault) });
    // Same fake Mac state: hand the device over.
    first.mac.devices.forEach((d, id) => t.mac.devices.set(id, d));
    await t.app.start();
    expect(heading(t.root)).toBe('Your Macs');
    expect(t.root.textContent).toContain('Waiting for you to allow this phone');
    click(t.root, /^Kason-MBP/);
    expect(heading(t.root)).toBe('Approve on your Mac');
    expect(t.root.querySelector('.code')?.textContent).toBe('482 913');
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
  });
});
