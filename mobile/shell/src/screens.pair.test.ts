// @vitest-environment jsdom
// AASC-17: the Pair and "Pair with <Mac>?" screens.
import { afterEach, describe, expect, it } from 'vitest';
import { HANDLED_LAUNCH_KEY } from './app';
import { MACS_KEY } from './savedMacs';
import {
  buttonNamed, click, createHarness, fill, fieldLabelled, heading, LAN_ONLY_LINK, LINK, pairUntilApproval, submit, TAILNET, until,
} from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

describe('Pair screen', () => {
  it('starts on Pair with nothing paired, and says scanning needs the app outside it', async () => {
    const t = createHarness();
    await t.app.start();
    expect(heading(t.root)).toBe('Pair with a Mac');
    expect(buttonNamed(t.root, 'Scan the QR code')).toBeNull();
    expect(t.root.textContent).toContain('Scanning needs the AASC app');
    expect(document.activeElement?.id).toBe('screen-title');
  });

  it('refuses something that isn’t a pairing link, and says why', async () => {
    const t = createHarness();
    await t.app.start();
    fill(t.root, 'Pairing link', 'https://evil.example/pair#v=2&name=X&ts=100.64.0.1&p=3333&mc=K7Q2M9XPZT');
    submit(t.root, 'Paste the pairing link');
    expect(t.app.current().name).toBe('pair');
    expect(fieldLabelled(t.root, 'Pairing link').getAttribute('aria-invalid')).toBe('true');
    expect(t.root.textContent).toContain('isn’t an AASC pairing link');
    // What was typed stays in the field.
    expect(fieldLabelled(t.root, 'Pairing link').value).toContain('evil.example');
  });

  it('never acts without a tap: a pasted link only asks "Pair with <Mac>?"', async () => {
    const t = createHarness();
    await t.app.start();
    fill(t.root, 'Pairing link', LINK);
    submit(t.root, 'Paste the pairing link');
    expect(heading(t.root)).toBe('Pair with Kason-MBP?');
    expect(t.root.textContent).toContain('100.101.102.103:3333 · encrypted');
    expect(t.mac.calls).toHaveLength(0);
  });

  it('pairs from a typed code too, through the same parser', async () => {
    const t = createHarness();
    await t.app.start();
    t.root.querySelector('details')?.setAttribute('open', '');
    fill(t.root, 'Mac address', '100.101.102.103');
    fill(t.root, 'Pairing code', 'k7q2m-9xpzt');
    submit(t.root, 'Type the pairing code');
    expect(heading(t.root)).toBe('Pair with Mac?');
  });

  it('points at the wrong field of a typed code', async () => {
    const t = createHarness();
    await t.app.start();
    fill(t.root, 'Mac address', '8.8.8.8');
    fill(t.root, 'Pairing code', 'K7Q2M9XPZT');
    submit(t.root, 'Type the pairing code');
    expect(fieldLabelled(t.root, 'Mac address').getAttribute('aria-invalid')).toBe('true');
    expect(t.root.querySelector('details')?.open).toBe(true);
    fill(t.root, 'Mac address', '100.101.102.103');
    fill(t.root, 'Pairing code', 'K7Q2M');
    submit(t.root, 'Type the pairing code');
    expect(fieldLabelled(t.root, 'Pairing code').getAttribute('aria-invalid')).toBe('true');
    expect(fieldLabelled(t.root, 'Mac address').value).toBe('100.101.102.103');
  });

  it('scans in the app, and refuses a QR that isn’t a pairing code', async () => {
    let next: string | null = 'https://example.com/menu';
    const t = createHarness({ scan: async () => next });
    await t.app.start();
    click(t.root, 'Scan the QR code');
    await until(t.root, () => t.root.textContent?.includes('isn’t an AASC pairing code') ?? false);
    next = LINK;
    click(t.root, 'Scan the QR code');
    await until(t.root, () => heading(t.root) === 'Pair with Kason-MBP?');
  });

  // Oct 27 2026: a Linux desktop's real pairing code named a public address and read "isn’t an AASC pairing code".
  it('says when a real pairing code names an address the app won’t dial', async () => {
    const t = createHarness({ scan: async () => 'https://aasc.work/pair#v=2&name=linux-box&lan=203.0.113.9&p=3333&mc=K7Q2M9XPZT' });
    await t.app.start();
    click(t.root, 'Scan the QR code');
    await until(t.root, () => t.root.textContent?.includes('names 203.0.113.9, which the app can’t reach') ?? false);
    expect(t.root.textContent).not.toContain('isn’t an AASC pairing code');
  });

  it('says when a pairing code names no address at all', async () => {
    const t = createHarness({ scan: async () => 'https://aasc.work/pair#v=2&name=linux-box&p=3333&mc=K7Q2M9XPZT' });
    await t.app.start();
    click(t.root, 'Scan the QR code');
    await until(t.root, () => t.root.textContent?.includes('names no address the app can reach') ?? false);
  });

  it('opens "Pair with <Mac>?" for the link that started the app, once', async () => {
    const first = createHarness({ launchUrl: LINK });
    await first.app.start();
    expect(heading(first.root)).toBe('Pair with Kason-MBP?');
    expect(first.store.get(HANDLED_LAUNCH_KEY)).toMatch(/^[0-9a-f]{64}$/); // a hash, not the link
    // Returning to the shell in the same app run hands over the same launch link.
    const again = createHarness({ launchUrl: LINK, store: Object.fromEntries(first.store) });
    await again.app.start();
    expect(heading(again.root)).toBe('Pair with a Mac');
  });

  it('opens "Pair with <Mac>?" for a link that arrives while the app runs', async () => {
    const t = createHarness();
    await t.app.start();
    t.openLink(LINK);
    expect(heading(t.root)).toBe('Pair with Kason-MBP?');
  });
});

describe('Pair with <Mac>?', () => {
  async function confirm(link = LINK) {
    const t = createHarness();
    await t.app.start();
    fill(t.root, 'Pairing link', link);
    submit(t.root, 'Paste the pairing link');
    return t;
  }

  it('leaves the home network off unless the user turns it on', async () => {
    const t = await confirm();
    expect(t.root.textContent).not.toContain('192.168.1.20:3333 · unencrypted');
    const lan = fieldLabelled(t.root, 'Also use the home network') as HTMLInputElement;
    expect(lan.checked).toBe(false);
    lan.focus(); // as a tap does
    lan.checked = true;
    lan.dispatchEvent(new Event('change', { bubbles: true }));
    expect(t.root.textContent).toContain('192.168.1.20:3333 · unencrypted');
    expect(document.activeElement?.id).toBe('allow-lan');
  });

  it('can’t pair a home-network-only Mac until that network is allowed', async () => {
    const t = await confirm(LAN_ONLY_LINK);
    expect(buttonNamed(t.root, 'Pair')?.disabled).toBe(true);
    const lan = fieldLabelled(t.root, 'Use the home network') as HTMLInputElement;
    lan.checked = true;
    lan.dispatchEvent(new Event('change', { bubbles: true }));
    expect(buttonNamed(t.root, 'Pair')?.disabled).toBe(false);
  });

  it('says the code expired and keeps nothing', async () => {
    const t = await confirm();
    t.mac.newCode('ZZZZZZZZZZ'); // the QR's code has lapsed on the Mac
    click(t.root, 'Pair');
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(t.root.textContent).toContain('The pairing code expired');
    expect(t.app.current().name).toBe('confirm');
    expect(t.vault.size).toBe(0);
    expect(JSON.parse(t.store.get(MACS_KEY) ?? '[]')).toEqual([]);
  });

  it('says the Mac can’t be reached and keeps nothing', async () => {
    const t = createHarness({ mac: { reachable: [] } });
    await t.app.start();
    fill(t.root, 'Pairing link', LINK);
    submit(t.root, 'Paste the pairing link');
    click(t.root, 'Pair');
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(t.root.textContent).toContain('Can’t reach Kason-MBP');
    expect(t.vault.size).toBe(0);
  });

  it('undoes the pairing on the Mac when the phone can’t store the key', async () => {
    const t = createHarness({ vaultFails: true });
    await t.app.start();
    fill(t.root, 'Pairing link', LINK);
    submit(t.root, 'Paste the pairing link');
    click(t.root, 'Pair');
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(t.root.textContent).toContain('couldn’t store the pairing key');
    expect([...t.mac.devices.values()].map((d) => d.status)).toEqual(['revoked']);
    expect(t.store.get(MACS_KEY)).toBeUndefined();
  });

  it('pairs over Tailscale with the phone’s name, then waits for the Mac', async () => {
    const t = createHarness();
    await t.app.start();
    fill(t.root, 'Pairing link', LINK);
    submit(t.root, 'Paste the pairing link');
    fill(t.root, 'Name for this phone', 'Kason’s Pixel');
    click(t.root, 'Pair');
    await until(t.root, () => heading(t.root) === 'Approve on your Mac');
    const pair = t.mac.calls.find((c) => c.url.endsWith('/api/mobile/pair'));
    expect(pair?.url).toBe(`${TAILNET}/api/mobile/pair`);
    expect(pair?.body).toMatchObject({ label: 'Kason’s Pixel', platform: 'android' });
  });

  it('sends the pairing an iPhone label on iOS', async () => {
    const t = createHarness({ os: 'ios' });
    await pairUntilApproval(t);
    expect(t.mac.calls.find((c) => c.url.endsWith('/api/mobile/pair'))?.body).toMatchObject({ label: 'iPhone', platform: 'ios' });
  });
});
