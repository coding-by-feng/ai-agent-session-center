// @vitest-environment jsdom
// AASC-17: Your Macs, a Mac's settings, unpairing, and Can't reach.
import { afterEach, describe, expect, it } from 'vitest';
import { loadMacs, readMacCredentials } from './savedMacs';
import {
  buttonNamed, click, createHarness, fieldLabelled, heading, KASON_MBP, LAN, seedMac, STUDIO, TAILNET, until,
} from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

async function twoMacs(opts: Parameters<typeof createHarness>[0] = {}) {
  const t = createHarness({ ...opts, mac: { reachable: [TAILNET, 'http://100.88.1.7:3333'], ...opts.mac } });
  await seedMac(t, { ...KASON_MBP, lanAllowed: true, lastPath: 'lan' });
  await seedMac(t, STUDIO);
  await t.app.start();
  return t;
}

describe('Your Macs', () => {
  it('lists every Mac with the path it uses, the unencrypted one marked', async () => {
    const t = await twoMacs();
    expect(heading(t.root)).toBe('Your Macs');
    const rows = Array.from(t.root.querySelectorAll('.mac')).map((r) => r.querySelector('.mac-open')?.textContent);
    expect(rows).toEqual(['Kason-MBPHome network · unencrypted', 'StudioTailscale']);
    expect(t.root.querySelector('.mac-sub.warn')).not.toBeNull();
    expect(buttonNamed(t.root, 'Settings for Studio')).not.toBeNull();
  });

  it('opens the Mac tapped, on the first path that answers', async () => {
    const t = await twoMacs();
    click(t.root, /^Studio/);
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual(['http://100.88.1.7:3333/']);
    expect(t.cookies.map((c) => c.origin)).toEqual(['http://100.88.1.7:3333']);
    // Kason-MBP's home network is tried first but doesn't answer here: Tailscale does.
    t.navigations.length = 0;
    click(t.root, 'Cancel');
    click(t.root, /^Kason-MBP/);
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect((await loadMacs(t.deps.store)).find((m) => m.name === 'Kason-MBP')?.lastPath).toBe('tailnet');
  });

  it('opens the only paired Mac straight away on launch', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await t.app.start();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
  });

  it('does not open the Mac by itself when the phone sent the app back for a notification tap', async () => {
    // AASC-19: a tap while a Mac's page showed reloads the shell with ?tap=1; the held tap picks the
    // session, so opening the Mac's home page here would race it.
    const t = createHarness({ search: '?tap=1' });
    await seedMac(t, KASON_MBP);
    await t.app.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.navigations).toEqual([]);
    expect(heading(t.root)).toBe('Your Macs');
  });

  it('adds another Mac from the list, with a way back', async () => {
    const t = await twoMacs();
    click(t.root, 'Pair another Mac');
    expect(heading(t.root)).toBe('Pair with a Mac');
    click(t.root, 'Your Macs');
    expect(heading(t.root)).toBe('Your Macs');
  });

  it('forgets a Mac that removed this phone, and says so', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP, 'revoked');
    await t.app.start();
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    expect(t.root.textContent).toContain('Kason-MBP removed this phone. Pair again to use it.');
    expect(t.vault.size).toBe(0);
    expect(t.cleared).toContain(TAILNET);
  });
});

describe('Mac settings', () => {
  it('turns the home network on and off for that Mac only', async () => {
    const t = await twoMacs();
    click(t.root, 'Settings for Studio');
    expect(heading(t.root)).toBe('Studio');
    expect(t.root.textContent).toContain('no home-network address');
    click(t.root, 'Your Macs');
    click(t.root, 'Settings for Kason-MBP');
    const lan = fieldLabelled(t.root, 'Use the home network') as HTMLInputElement;
    expect(lan.checked).toBe(true);
    lan.checked = false;
    lan.dispatchEvent(new Event('change', { bubbles: true }));
    await until(t.root, () => t.root.textContent?.includes('Only Tailscale is used now.') ?? false);
    const saved = await loadMacs(t.deps.store);
    expect(saved.find((m) => m.name === 'Kason-MBP')).toMatchObject({ lanAllowed: false, lastPath: null });
    expect(saved.find((m) => m.name === 'Studio')?.lanAllowed).toBe(false);
    expect(t.allowed.at(-1)).toEqual([TAILNET, 'http://100.88.1.7:3333']);
  });

  it('unpairs after asking: the Mac is told, push stops, the phone forgets', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    t.vault.set(`backend.${KASON_MBP.id}`, JSON.stringify({ host: 'api.aasc.work', deviceId: 'be-1', token: 'b'.repeat(43) }));
    await t.app.start();
    click(t.root, 'Settings for Kason-MBP');
    click(t.root, 'Unpair this phone');
    expect(t.root.textContent).toContain('Unpair from Kason-MBP?');
    click(t.root, 'Keep it');
    click(t.root, 'Unpair this phone');
    click(t.root, 'Unpair');
    await until(t.root, () => heading(t.root) === 'Your Macs');
    expect(t.root.textContent).toContain('Unpaired from Kason-MBP.');
    expect(t.mac.pushTargetsRemoved()).toBe(1);
    expect([...t.mac.devices.values()].map((d) => d.status)).toEqual(['revoked', 'active']);
    expect(await readMacCredentials(t.deps.vault, KASON_MBP.id)).toBeNull();
    expect(t.vault.has(`backend.${KASON_MBP.id}`)).toBe(false);
    expect((await loadMacs(t.deps.store)).map((m) => m.name)).toEqual(['Studio']);
    expect(t.cleared).toEqual(expect.arrayContaining([TAILNET, LAN]));
  });

  it('asks before removing a Mac it can’t tell, then removes it from the phone', async () => {
    const t = createHarness({ mac: { reachable: [] } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    click(t.root, 'Settings for Kason-MBP');
    click(t.root, 'Unpair this phone');
    click(t.root, 'Unpair');
    await until(t.root, () => t.root.textContent?.includes('still lists this phone') ?? false);
    expect(t.vault.size).toBe(2); // nothing forgotten yet
    click(t.root, 'Remove anyway');
    await until(t.root, () => heading(t.root) === 'Your Macs');
    expect(t.root.textContent).toContain('Revoke it in the Mac’s devices panel too.');
    expect((await loadMacs(t.deps.store)).map((m) => m.name)).toEqual(['Studio']);
  });
});

describe('Can’t reach', () => {
  it('lists the paths tried and the home network not allowed, then allows it', async () => {
    const t = createHarness({ mac: { reachable: [LAN] } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    click(t.root, /^Kason-MBP/);
    await until(t.root, () => heading(t.root) === 'Can’t reach Kason-MBP');
    const paths = Array.from(t.root.querySelectorAll('.path')).map((p) => p.textContent);
    expect(paths).toEqual([
      'Tailscale100.101.102.103:3333 · encrypted · no answer',
      'Home network192.168.1.20:3333 · unencrypted · not allowed',
    ]);
    click(t.root, 'Allow the home network…');
    const lan = fieldLabelled(t.root, 'Use the home network') as HTMLInputElement;
    lan.checked = true;
    lan.dispatchEvent(new Event('change', { bubbles: true }));
    await until(t.root, () => t.root.textContent?.includes('tried first now') ?? false);
    click(t.root, 'Open Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${LAN}/`]);
  });

  it('tries again when asked', async () => {
    const t = createHarness({ mac: { reachable: [] } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    click(t.root, /^Studio/);
    await until(t.root, () => heading(t.root) === 'Can’t reach Studio');
    expect(t.root.textContent).toContain('Check that Tailscale is on');
    t.mac.setReachable(['http://100.88.1.7:3333']);
    click(t.root, 'Try again');
    await until(t.root, () => t.navigations.length > 0);
  });

  it('says why when the Mac answers but sign-in fails', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    const real = t.deps.http.post;
    t.deps.http.post = async (url, body) => (url.endsWith('/api/mobile/session') ? { status: 429, data: { error: 'Too many attempts' } } : real(url, body));
    await t.app.start();
    click(t.root, /^Kason-MBP/);
    await until(t.root, () => heading(t.root) === 'Couldn’t open Kason-MBP');
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain('Sign-in failed (429)');
  });
});
