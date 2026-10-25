// @vitest-environment jsdom
// AASC-17: Your Macs, a Mac's settings, unpairing, and Can't reach.
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_SETTINGS_KEY } from './lockGate';
import { LAST_MAC_KEY, loadMacs, readBackendCredential, readMacCredentials, saveMacs, withMac, writeMacCredentials } from './savedMacs';
import {
  buttonNamed, click, createHarness, fieldLabelled, heading, KASON_MBP, LAN, LINK, seedMac, STUDIO, TAILNET, until,
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

  // Oct 21 2026: with two Macs saved (re-pairing leaves two rows for one Mac), every launch stopped at the list.
  it('opens the Mac used last on launch when several are paired', async () => {
    const t = createHarness({ mac: { reachable: [TAILNET, 'http://100.88.1.7:3333'] }, store: { [LAST_MAC_KEY]: STUDIO.id } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual(['http://100.88.1.7:3333/']);
  });

  it('shows the list when the Mac used last is gone', async () => {
    const t = createHarness({ store: { [LAST_MAC_KEY]: '6f1c2a10-0000-4000-8000-0000000000ff' } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.navigations).toEqual([]);
    expect(heading(t.root)).toBe('Your Macs');
  });

  // Review, Oct 21 2026: opening the old row signs in, and releasedTwins then retires the waiting re-pair of the
  // same Mac (its key proves "pending" there), so a launch after the app was killed mid-approval undid the re-pair.
  it('shows the list while a pairing waits for approval, even with a Mac used last: the waiting one is kept', async () => {
    for (const twinOnMac of ['pending', 'active'] as const) { // the Mac may have allowed it while the app was gone
      document.body.replaceChildren();
      const repair = { ...KASON_MBP, id: '6f1c2a10-0000-4000-8000-000000000003', status: 'pending' as const, confirmCode: '482913' };
      const t = createHarness({ store: { [LAST_MAC_KEY]: KASON_MBP.id } });
      await seedMac(t, KASON_MBP);
      await seedMac(t, repair, twinOnMac);
      await t.app.start();
      await new Promise((r) => setTimeout(r, 50));
      expect(t.navigations).toEqual([]);
      expect(heading(t.root)).toBe('Your Macs');
      expect((await loadMacs(t.deps.store)).map((m) => m.id)).toEqual([KASON_MBP.id, repair.id]);
    }
  });

  it('still opens the only paired Mac when the one used last was removed', async () => {
    const t = createHarness({ store: { [LAST_MAC_KEY]: STUDIO.id } });
    await seedMac(t, KASON_MBP);
    await t.app.start();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
  });

  it('stays on the list when the Mac’s page sent the app back to switch Macs (?tap=1)', async () => {
    // More → Switch Mac opens nativeShellHomeUrl(): opening the Mac used last there would bounce straight back.
    const t = createHarness({ search: '?tap=1', store: { [LAST_MAC_KEY]: STUDIO.id } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.navigations).toEqual([]);
    expect(heading(t.root)).toBe('Your Macs');
    expect(buttonNamed(t.root, 'Pair another Mac')).not.toBeNull();
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

  // Oct 20 2026: unpairing was only under ⚙ → the Mac's settings; two rows can share a name.
  describe('unpairing from the list', () => {
    const rowsText = (t: { root: HTMLElement }) => Array.from(t.root.querySelectorAll('.mac')).map((r) => r.querySelector('.mac-name')?.textContent);
    const row = (t: { root: HTMLElement }, i: number) => t.root.querySelectorAll<HTMLElement>('.mac')[i];

    it('asks in the row tapped, then the Mac is told, push stops and the phone forgets', async () => {
      const t = await twoMacs();
      t.vault.set(`backend.${KASON_MBP.id}`, JSON.stringify(t.mac.seedBackendDevice()));
      click(t.root, 'Unpair from Kason-MBP');
      expect(heading(t.root)).toBe('Your Macs');
      expect(row(t, 0).textContent).toContain('Unpair from Kason-MBP? This phone loses access and forgets its key.');
      expect(row(t, 0).dataset.unpairing).toBe('true');
      expect(row(t, 1).textContent).not.toContain('Unpair from');
      click(t.root, 'Keep it');
      expect(t.root.textContent).not.toContain('Unpair from Kason-MBP?');
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Unpair from Kason-MBP');
      click(t.root, 'Unpair from Kason-MBP');
      click(t.root, 'Unpair');
      await until(t.root, () => t.root.textContent?.includes('Unpaired from Kason-MBP.') ?? false);
      expect(heading(t.root)).toBe('Your Macs');
      expect(rowsText(t)).toEqual(['Studio']);
      expect(t.mac.pushTargetsRemoved()).toBe(1);
      expect([...t.mac.devices.values()].map((d) => d.status)).toEqual(['revoked', 'active']);
      expect(await readMacCredentials(t.deps.vault, KASON_MBP.id)).toBeNull();
      expect((await loadMacs(t.deps.store)).map((m) => m.name)).toEqual(['Studio']);
    });

    it('tells two Macs of the same name apart: the question sits in the row tapped, one row at a time', async () => {
      const t = createHarness();
      const twin = { ...KASON_MBP, id: '6f1c2a10-0000-4000-8000-000000000003' };
      await seedMac(t, KASON_MBP);
      await seedMac(t, twin);
      await t.app.start();
      await until(t.root, () => heading(t.root) === 'Your Macs');
      row(t, 1).querySelector<HTMLButtonElement>('[aria-label="Unpair from Kason-MBP"]')?.click();
      expect(row(t, 1).textContent).toContain('Unpair from Kason-MBP?');
      expect(row(t, 0).textContent).not.toContain('Unpair from Kason-MBP?');
      row(t, 0).querySelector<HTMLButtonElement>('[aria-label="Unpair from Kason-MBP"]')?.click();
      expect(row(t, 0).textContent).toContain('Unpair from Kason-MBP?');
      expect(row(t, 1).textContent).not.toContain('Unpair from Kason-MBP?');
      click(t.root, 'Unpair');
      await until(t.root, () => t.root.textContent?.includes('Unpaired from Kason-MBP.') ?? false);
      expect((await loadMacs(t.deps.store)).map((m) => m.id)).toEqual([twin.id]);
    });

    it('asks again before removing a Mac it can’t tell, then removes it from the phone only', async () => {
      const t = createHarness({ mac: { reachable: [] } });
      await seedMac(t, KASON_MBP);
      await seedMac(t, STUDIO);
      await t.app.start();
      click(t.root, 'Unpair from Studio');
      click(t.root, 'Unpair');
      await until(t.root, () => row(t, 1).textContent?.includes('still lists this phone') ?? false);
      expect(t.vault.size).toBe(2); // nothing forgotten yet
      click(t.root, 'Remove anyway');
      await until(t.root, () => t.root.textContent?.includes('Revoke it in the Mac’s devices panel too.') ?? false);
      expect(rowsText(t)).toEqual(['Kason-MBP']);
    });

    it('after the lock, an unpair that finished meanwhile leaves no row stuck: another Mac can be asked', async () => {
      // The lock shows the screen from before it again, with that row still "Telling …" (review, Oct 20 2026).
      const t = createHarness({ biometric: { available: true, pass: true }, store: { [LOCK_SETTINGS_KEY]: JSON.stringify({ enabled: true, relockAfterMinutes: 0 }) } });
      await seedMac(t, KASON_MBP);
      await seedMac(t, STUDIO);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const real = t.deps.http.post;
      t.deps.http.post = async (url, body) => {
        if (url.endsWith('/api/mobile/unpair')) await held;
        return real(url, body);
      };
      await t.app.start();
      click(t.root, 'Unlock');
      await until(t.root, () => heading(t.root) === 'Your Macs');
      click(t.root, 'Unpair from Kason-MBP');
      click(t.root, 'Unpair');
      await until(t.root, () => t.root.textContent?.includes('Telling Kason-MBP') ?? false);
      t.extras.pause!();
      await new Promise((r) => setTimeout(r, 5));
      t.extras.resume!();
      await until(t.root, () => heading(t.root) === 'AASC is locked');
      release();
      await until(t.root, () => !t.vault.has(`mac.${KASON_MBP.id}`));
      await new Promise((r) => setTimeout(r, 5));
      click(t.root, 'Unlock');
      await until(t.root, () => heading(t.root) === 'Your Macs');
      expect(rowsText(t)).toEqual(['Studio']);
      expect(t.root.textContent).not.toContain('Telling');
      click(t.root, 'Unpair from Studio');
      expect(row(t, 0).textContent).toContain('Unpair from Studio?');
    });

    it('keeps the list right when the screen moved on before the Mac answered', async () => {
      const t = await twoMacs();
      click(t.root, 'Settings for Kason-MBP');
      click(t.root, 'Unpair this phone');
      click(t.root, 'Unpair');
      click(t.root, 'Your Macs'); // back, while the Mac is still being told
      await until(t.root, () => rowsText(t).length === 1);
      expect(rowsText(t)).toEqual(['Studio']);
    });
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
    t.vault.set(`backend.${KASON_MBP.id}`, JSON.stringify(t.mac.seedBackendDevice()));
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

// Oct 20 2026: pairing the same Mac again added a second row (each pairing gets its own id).
describe('one row per Mac', () => {
  type T = ReturnType<typeof createHarness>;
  const TWIN = { ...KASON_MBP, id: '6f1c2a10-0000-4000-8000-000000000003' };
  const unpairCalls = (t: T) => t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/unpair'));
  const deviceOf = async (t: T, id: string) => (await readMacCredentials(t.deps.vault, id))!.deviceId;
  const ids = async (t: T) => (await loadMacs(t.deps.store)).map((m) => m.id);
  const withPush = (t: T, ...macIds: string[]) => macIds.forEach((id) => t.vault.set(`backend.${id}`, JSON.stringify(t.mac.seedBackendDevice())));
  async function openFirstRow(t: T) {
    await t.app.start();
    await until(t.root, () => heading(t.root) === 'Your Macs');
    t.root.querySelectorAll<HTMLButtonElement>('.mac-open')[0].click();
  }

  it('pairing the Mac again replaces its row once the Mac allows the new one, and the Mac drops the old key', async () => {
    const t = await twoMacs();
    const cookieLog: string[] = [];
    const { set, clear } = t.deps.cookies;
    t.deps.cookies.set = async (origin, token, maxAge) => {
      cookieLog.push(`set ${origin}`);
      return set(origin, token, maxAge);
    };
    t.deps.cookies.clear = async (origin) => {
      cookieLog.push(`clear ${origin}`);
      return clear(origin);
    };
    const oldDevice = await deviceOf(t, KASON_MBP.id);
    t.openLink(LINK);
    await until(t.root, () => t.root.dataset.screen === 'confirm');
    click(t.root, 'Pair');
    await until(t.root, () => heading(t.root) === 'Approve on your Mac');
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    const saved = await loadMacs(t.deps.store);
    expect(saved.map((m) => m.name)).toEqual(['Studio', 'Kason-MBP']);
    expect(saved.find((m) => m.name === 'Kason-MBP')?.id).not.toBe(KASON_MBP.id);
    expect(await readMacCredentials(t.deps.vault, KASON_MBP.id)).toBeNull();
    expect(t.mac.devices.get(oldDevice)?.status).toBe('revoked');
    // The old row's cookies (it shares this origin) are cleared before the new session's is set.
    expect(cookieLog.lastIndexOf(`clear ${TAILNET}`)).toBeLessThan(cookieLog.indexOf(`set ${TAILNET}`));
    expect(cookieLog.at(-1)).toBe(`set ${TAILNET}`);
    expect(t.mac.strikes()).toBe(0);
  });

  it('keeps the old row while the new pairing waits: a re-pair never allowed leaves the one that works', async () => {
    const t = await twoMacs();
    const oldDevice = await deviceOf(t, KASON_MBP.id);
    t.openLink(LINK);
    await until(t.root, () => t.root.dataset.screen === 'confirm');
    click(t.root, 'Pair');
    await until(t.root, () => heading(t.root) === 'Approve on your Mac');
    const pending = [...t.mac.devices.keys()].at(-1);
    const checks = () => t.mac.calls.filter((c) => c.url.endsWith('/api/mobile/session') && (c.body as { deviceId: string }).deviceId === pending).length;
    await until(t.root, () => checks() >= 3); // the approval checks ran
    expect(await ids(t)).toContain(KASON_MBP.id);
    expect(t.mac.devices.get(oldDevice)?.status).toBe('active');
    expect(unpairCalls(t)).toEqual([]);
  });

  it('opening one of two rows for the same Mac removes the other: push first, then the Mac, then the phone', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, TWIN);
    withPush(t, KASON_MBP.id, TWIN.id);
    const twinDevice = await deviceOf(t, TWIN.id);
    await openFirstRow(t);
    await until(t.root, () => t.navigations.length > 0);
    expect(await ids(t)).toEqual([KASON_MBP.id]);
    expect(await readMacCredentials(t.deps.vault, TWIN.id)).toBeNull();
    expect(await readBackendCredential(t.deps.vault, TWIN.id)).toBeNull();
    expect(await readBackendCredential(t.deps.vault, KASON_MBP.id)).not.toBeNull();
    expect(t.mac.devices.get(twinDevice)?.status).toBe('revoked');
    expect(t.mac.devices.get(await deviceOf(t, KASON_MBP.id))?.status).toBe('active');
    expect(t.mac.pushTargetsRemoved()).toBe(1);
    const urls = t.mac.calls.map((c) => `${c.method} ${c.url}`);
    expect(urls.indexOf('DELETE https://api.aasc.work/v1/push/targets/self')).toBeLessThan(urls.indexOf(`POST ${TAILNET}/api/mobile/unpair`));
  });

  it('removes a row the Mac already revoked without asking it again (the usual reason to re-pair)', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, TWIN, 'revoked');
    await openFirstRow(t);
    await until(t.root, () => t.navigations.length > 0);
    expect(await ids(t)).toEqual([KASON_MBP.id]);
    expect(await readMacCredentials(t.deps.vault, TWIN.id)).toBeNull();
    expect(unpairCalls(t)).toEqual([]);
    expect(t.mac.strikes()).toBe(0);
  });

  it('cancels a pairing still waiting for approval when the old row of that Mac opens', async () => {
    const t = createHarness();
    const waiting = { ...TWIN, status: 'pending' as const, confirmCode: '482913' };
    await seedMac(t, KASON_MBP);
    await seedMac(t, waiting, 'pending');
    const waitingDevice = await deviceOf(t, waiting.id);
    await openFirstRow(t);
    await until(t.root, () => t.navigations.length > 0);
    expect(await ids(t)).toEqual([KASON_MBP.id]);
    expect(t.mac.devices.get(waitingDevice)?.status).toBe('revoked');
  });

  it('leaves a row whose key the Mac doesn’t know (it may be another Mac), and never proves it there again', async () => {
    const t = createHarness();
    const office = { ...KASON_MBP, id: '6f1c2a10-0000-4000-8000-000000000004', name: 'Office-Mac' };
    await seedMac(t, KASON_MBP);
    await writeMacCredentials(t.deps.vault, office.id, { deviceId: crypto.randomUUID(), deviceToken: 'f'.repeat(64) });
    await saveMacs(t.deps.store, withMac(await loadMacs(t.deps.store), office));
    await t.app.start();
    await until(t.root, () => heading(t.root) === 'Your Macs');
    click(t.root, /^Kason-MBP/);
    await until(t.root, () => t.navigations.length > 0);
    expect((await loadMacs(t.deps.store)).map((m) => m.name)).toEqual(['Kason-MBP', 'Office-Mac']);
    expect(await readMacCredentials(t.deps.vault, office.id)).not.toBeNull();
    expect(unpairCalls(t)).toEqual([]);
    expect(t.mac.strikes()).toBe(1); // the Mac's login limiter allows 5 per 15 minutes
    document.body.replaceChildren();
    // The next launch (the shell reloads every time it comes back from a Mac's page) doesn't ask again.
    const again = createHarness({ fakeMac: t.mac, store: Object.fromEntries(t.store), vault: Object.fromEntries(t.vault) });
    await again.app.start(); // it opens Kason-MBP, the Mac used last, by itself
    await until(again.root, () => again.navigations.length > 0);
    expect(t.mac.strikes()).toBe(1);
    expect((await loadMacs(again.deps.store)).map((m) => m.name)).toEqual(['Kason-MBP', 'Office-Mac']);
  });

  it('keeps the other row’s push while the opened one has none yet: its link failed', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, TWIN);
    withPush(t, TWIN.id);
    t.mac.setBackendDown(true); // Kason-MBP's backend link fails
    await openFirstRow(t);
    await until(t.root, () => t.navigations.length > 0);
    expect(await ids(t)).toEqual([KASON_MBP.id, TWIN.id]);
    expect(await readBackendCredential(t.deps.vault, TWIN.id)).not.toBeNull();
    expect(t.mac.pushTargetsRemoved()).toBe(0);
    expect(unpairCalls(t)).toEqual([]);
  });

  it('retires nothing more once the user cancels, and the list still matches what is saved', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, TWIN);
    withPush(t, KASON_MBP.id, TWIN.id);
    const twinDevice = await deviceOf(t, TWIN.id);
    const release = t.mac.holdNextBackendRequest(); // the twin's push removal
    await openFirstRow(t);
    await until(t.root, () => t.mac.calls.some((c) => c.method === 'DELETE'));
    click(t.root, 'Cancel');
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.navigations).toEqual([]);
    expect(unpairCalls(t)).toEqual([]);
    expect(t.mac.devices.get(twinDevice)?.status).toBe('active');
    expect(await ids(t)).toEqual([KASON_MBP.id, TWIN.id]);
    expect(t.root.querySelectorAll('.mac')).toHaveLength(2);
  });

  it('keeps the list right when the user cancels after the other row was already retired', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, TWIN);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const { set } = t.deps.cookies;
    t.deps.cookies.set = async (origin, token, maxAge) => {
      await held; // the sign-in is past the retire, setting the cookie
      return set(origin, token, maxAge);
    };
    await openFirstRow(t);
    await until(t.root, () => unpairCalls(t).length === 1);
    await new Promise((r) => setTimeout(r, 10));
    click(t.root, 'Cancel');
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(t.navigations).toEqual([]);
    expect(await ids(t)).toEqual([KASON_MBP.id]);
    expect(heading(t.root)).toBe('Your Macs');
    expect(t.root.querySelectorAll('.mac')).toHaveLength(1); // not the retired row as well
  });

  it('keeps the list right when the sign-in fails after the other row was retired', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    await seedMac(t, TWIN);
    t.deps.cookies.set = async () => {
      throw new Error('cookie store unavailable');
    };
    await openFirstRow(t);
    await until(t.root, () => heading(t.root) === 'Couldn’t open Kason-MBP');
    expect(await ids(t)).toEqual([KASON_MBP.id]);
    click(t.root, 'Your Macs');
    expect(t.root.querySelectorAll('.mac')).toHaveLength(1);
  });

  it('cancelling a re-pair while the old row is checked keeps the old row and drops the new one', async () => {
    const t = await twoMacs();
    const oldDevice = await deviceOf(t, KASON_MBP.id);
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let checkingOld = false;
    const post = t.deps.http.post;
    t.deps.http.post = async (url, body) => {
      if (url.endsWith('/api/mobile/session') && (body as { deviceId?: string }).deviceId === oldDevice) {
        checkingOld = true; // the new row signed in and the retire is proving the old row's key
        await held;
      }
      return post(url, body);
    };
    t.openLink(LINK);
    await until(t.root, () => t.root.dataset.screen === 'confirm');
    click(t.root, 'Pair');
    await until(t.root, () => heading(t.root) === 'Approve on your Mac');
    const newDevice = [...t.mac.devices.keys()].at(-1)!;
    t.mac.approve();
    await until(t.root, () => checkingOld);
    click(t.root, 'Cancel pairing');
    release();
    await until(t.root, () => t.mac.devices.get(newDevice)?.status === 'revoked');
    await new Promise((r) => setTimeout(r, 20));
    expect(t.navigations).toEqual([]);
    expect(unpairCalls(t).map((c) => (c.body as { deviceId: string }).deviceId)).toEqual([newDevice]);
    expect(t.mac.devices.get(oldDevice)?.status).toBe('active');
    expect((await loadMacs(t.deps.store)).map((m) => m.id)).toEqual([KASON_MBP.id, STUDIO.id]);
    expect(await readMacCredentials(t.deps.vault, KASON_MBP.id)).not.toBeNull();
  });

  it('asks the Mac about at most one key it may not know per sign-in (each is a login-limit strike)', async () => {
    const t = createHarness();
    await seedMac(t, KASON_MBP);
    for (const n of [4, 5]) {
      const other = { ...KASON_MBP, id: `6f1c2a10-0000-4000-8000-00000000000${n}`, name: `Office-${n}` };
      await writeMacCredentials(t.deps.vault, other.id, { deviceId: crypto.randomUUID(), deviceToken: 'f'.repeat(64) });
      await saveMacs(t.deps.store, withMac(await loadMacs(t.deps.store), other));
    }
    let h: T = t;
    for (const strikes of [1, 2, 2]) {
      await h.app.start();
      // The first launch has no Mac used last, so it lists; the later ones open Kason-MBP by themselves.
      if (h === t) {
        await until(h.root, () => heading(h.root) === 'Your Macs');
        click(h.root, /^Kason-MBP/);
      }
      await until(h.root, () => h.navigations.length > 0);
      expect(t.mac.strikes()).toBe(strikes);
      document.body.replaceChildren();
      h = createHarness({ fakeMac: t.mac, store: Object.fromEntries(h.store), vault: Object.fromEntries(h.vault) });
    }
    expect((await loadMacs(h.deps.store)).map((m) => m.name)).toEqual(['Kason-MBP', 'Office-4', 'Office-5']);
  });

  it('opens the Mac anyway when retiring the other row takes too long, and keeps that row for next time', async () => {
    const t = createHarness({ timing: { pollMs: 5, pollMaxMs: 60_000, retireMs: 40 } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, TWIN);
    withPush(t, KASON_MBP.id, TWIN.id);
    const twinDevice = await deviceOf(t, TWIN.id);
    t.mac.setBackendHang(true); // removing the twin's push target never answers
    await openFirstRow(t);
    await until(t.root, () => t.navigations.length > 0);
    expect(await ids(t)).toEqual([KASON_MBP.id, TWIN.id]);
    expect(await readMacCredentials(t.deps.vault, TWIN.id)).not.toBeNull();
    expect(t.mac.devices.get(twinDevice)?.status).toBe('active');
    expect(unpairCalls(t)).toEqual([]);
  });
});
