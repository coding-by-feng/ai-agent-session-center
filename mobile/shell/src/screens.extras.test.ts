// @vitest-environment jsdom
// AASC-21 / AASC-19: share to a session's queue, the biometric lock, push (inert without Firebase).
import { afterEach, describe, expect, it } from 'vitest';
import { LOCK_SETTINGS_KEY, LOCK_STATE_KEY } from './lockGate';
import { LAST_MAC_KEY, loadMacs } from './savedMacs';
import { LAST_SHARE_TARGET_KEY } from './shareFlow';
import { buttonNamed, click, createHarness, heading, KASON_MBP, pairUntilApproval, seedMac, STUDIO, TAILNET, until, type HarnessOptions } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

const SESSIONS = [
  { sessionId: 'sess-a', status: 'approval', title: 'Fix the build', lastActivityAt: 2 },
  { sessionId: 'sess-b', status: 'idle', title: 'Write docs', lastActivityAt: 5 },
  { sessionId: 'sess-c', status: 'ended', title: 'Old one', lastActivityAt: 9 },
];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

async function sharing(opts: HarnessOptions, macs = [KASON_MBP]) {
  const t = createHarness({ widget: true, ...opts, mac: { reachable: [TAILNET, 'http://100.88.1.7:3333'], sessions: SESSIONS, ...opts.mac } });
  for (const m of macs) await seedMac(t, m);
  await t.app.start();
  return t;
}

describe('Share to AASC', () => {
  it('lists the shared, live sessions of the only Mac and adds the text paused', async () => {
    const t = await sharing({ share: { text: 'Look at\r\nthis \u001b[31mlog\u001b[0m' } });
    expect(heading(t.root)).toBe('Share to AASC');
    expect(t.root.textContent).toContain('It arrives paused');
    await until(t.root, () => buttonNamed(t.root, /^Write docs/) !== null);
    const rows = Array.from(t.root.querySelectorAll('.mac-name')).map((n) => n.textContent);
    expect(rows).toEqual(['Write docs', 'Fix the build']); // most recent first, ended left out
    click(t.root, /^Fix the build/);
    await until(t.root, () => t.root.textContent?.includes('Added paused') ?? false);
    expect(t.mac.queued).toEqual([['sess-a', { text: 'Look at\nthis log' }]]);
    expect(t.store.get(LAST_SHARE_TARGET_KEY)).toBe('sess-a');
    expect(buttonNamed(t.root, 'Open Kason-MBP')).not.toBeNull();
    // The widget followed the list it saw: one session needs approval.
    expect(JSON.parse(t.extras.widget.at(-1)!)).toMatchObject({ needYou: 1, top: { title: 'Fix the build' } });
    // Nothing of the session token stayed anywhere.
    for (const secret of t.mac.issued) expect([...t.store.values(), t.root.textContent].join()).not.toContain(secret);
    expect(t.navigations).toEqual([]);
  });

  it('sends images with their metadata stripped', async () => {
    const t = await sharing({ share: { images: [{ name: 'shot.png', mimeType: 'image/png', base64: PNG }] } });
    expect(t.root.textContent).toContain('1 image');
    await until(t.root, () => buttonNamed(t.root, /^Write docs/) !== null);
    click(t.root, /^Write docs/);
    await until(t.root, () => t.mac.queued.length === 1);
    const body = t.mac.queued[0][1] as { images: Array<{ name: string; dataUrl: string }> };
    expect(body.images[0].name).toBe('shot.png');
    expect(body.images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it('asks which Mac when there are several', async () => {
    const t = await sharing({ share: { text: 'hi' } }, [KASON_MBP, STUDIO]);
    expect(t.root.textContent).toContain('Which Mac');
    click(t.root, /^Studio/);
    await until(t.root, () => t.root.textContent?.includes('Sessions on Studio') ?? false);
  });

  it('says what the phone refused before reading it all, and adds nothing', async () => {
    const t = await sharing({ share: { problem: 'too-many' } });
    expect(t.root.querySelector('[role="alert"]')?.textContent).toContain('At most 10 images. Nothing was added.');
    expect(t.mac.calls).toHaveLength(0);
  });

  it('refuses text over 64 KB with nothing added', async () => {
    const t = await sharing({ share: { text: 'x'.repeat(64 * 1024 + 1) } });
    await until(t.root, () => buttonNamed(t.root, /^Write docs/) !== null);
    click(t.root, /^Write docs/);
    await until(t.root, () => t.root.querySelector('[role="alert"]') !== null);
    expect(t.root.textContent).toContain('the limit is 64 KB');
    expect(t.mac.queued).toEqual([]);
  });

  it('needs a paired Mac first', async () => {
    const t = await sharing({ share: { text: 'hi' } }, []);
    expect(t.root.textContent).toContain('Pair a Mac first');
    click(t.root, 'Pair a Mac');
    expect(heading(t.root)).toBe('Pair with a Mac');
  });

  it('forgets a Mac that removed this phone', async () => {
    const t = createHarness({ share: { text: 'hi' }, mac: { sessions: SESSIONS } });
    await seedMac(t, KASON_MBP, 'revoked');
    await t.app.start();
    await until(t.root, () => t.root.textContent?.includes('This Mac removed this phone') ?? false);
    expect(await loadMacs(t.deps.store)).toEqual([]);
  });

  it('starts normally when nothing was shared', async () => {
    const t = await sharing({ share: null });
    await until(t.root, () => t.navigations.length > 0); // the only Mac opens
  });
});

describe('Biometric lock', () => {
  const lockOn = { [LOCK_SETTINGS_KEY]: JSON.stringify({ enabled: true, relockAfterMinutes: 5 }) };

  it('asks at a cold start before anything else, then carries on', async () => {
    const t = createHarness({ biometric: { available: true, pass: false }, store: lockOn });
    await seedMac(t, KASON_MBP);
    await t.app.start();
    expect(heading(t.root)).toBe('AASC is locked');
    expect(t.mac.calls).toHaveLength(0); // nothing reached a Mac while locked
    click(t.root, 'Unlock');
    await until(t.root, () => t.root.textContent?.includes('Not unlocked') ?? false);
    t.extras.biometricPass = true;
    click(t.root, 'Unlock');
    await until(t.root, () => t.navigations.length > 0);
    expect(JSON.parse(t.store.get(LOCK_STATE_KEY)!)).toMatchObject({ unlockedBootId: 'boot-1' });
  });

  it('doesn’t ask again within the grace time, and asks after a reboot', async () => {
    const now = Date.now();
    const state = JSON.stringify({ unlockedAt: now - 1_000, unlockedBootId: 'boot-1', backgroundedAt: now - 1_000, tapStartedAt: null });
    const t = createHarness({ biometric: { available: true, pass: true }, store: { ...lockOn, [LOCK_STATE_KEY]: state } });
    await seedMac(t, KASON_MBP);
    await t.app.start();
    await until(t.root, () => t.navigations.length > 0);
    const rebooted = createHarness({ biometric: { available: true, pass: true, bootId: 'boot-2' }, store: { ...lockOn, [LOCK_STATE_KEY]: state } });
    await rebooted.app.start();
    expect(heading(rebooted.root)).toBe('AASC is locked');
  });

  it('takes the native resume path: locks after the time away, then returns to the page', async () => {
    const now = Date.now();
    const state = JSON.stringify({ unlockedAt: now - 3_600_000, unlockedBootId: 'boot-1', backgroundedAt: null, tapStartedAt: null });
    const away = now - 10 * 60_000;
    const t = createHarness({
      biometric: { available: true, pass: true },
      search: `?resume=1&away=${away}&back=%2Fqueue`,
      store: { ...lockOn, [LOCK_STATE_KEY]: state, [LAST_MAC_KEY]: KASON_MBP.id },
    });
    await seedMac(t, KASON_MBP);
    await t.app.start();
    expect(heading(t.root)).toBe('AASC is locked');
    click(t.root, 'Unlock');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/queue`]);
  });

  it('locks on resume while the shell shows, and comes back to the same screen', async () => {
    const t = createHarness({ biometric: { available: true, pass: true }, store: { [LOCK_SETTINGS_KEY]: JSON.stringify({ enabled: true, relockAfterMinutes: 0 }) } });
    await t.app.start();
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
    t.extras.pause!();
    await new Promise((r) => setTimeout(r, 5));
    t.extras.resume!();
    await until(t.root, () => heading(t.root) === 'AASC is locked');
    click(t.root, 'Unlock');
    await until(t.root, () => heading(t.root) === 'Pair with a Mac');
  });

  it('turns on only after the phone confirmed it’s you, from This phone', async () => {
    const t = createHarness({ biometric: { available: true, pass: false } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    click(t.root, 'This phone');
    const toggle = t.root.querySelector<HTMLInputElement>('#phone-lock')!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await until(t.root, () => t.root.textContent?.includes('The lock stays off') ?? false);
    expect(t.store.get(LOCK_SETTINGS_KEY)).toBeUndefined();
    t.extras.biometricPass = true;
    const again = t.root.querySelector<HTMLInputElement>('#phone-lock')!;
    again.checked = true;
    again.dispatchEvent(new Event('change', { bubbles: true }));
    await until(t.root, () => t.root.textContent?.includes('now asks') ?? false);
    expect(JSON.parse(t.store.get(LOCK_SETTINGS_KEY)!)).toEqual({ enabled: true, relockAfterMinutes: 5 });
    const select = t.root.querySelector<HTMLSelectElement>('#phone-relock')!;
    select.value = '15';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await until(t.root, () => JSON.parse(t.store.get(LOCK_SETTINGS_KEY)!).relockAfterMinutes === 15);
  });
});

describe('Push without the Firebase config', () => {
  it('creates the four channels and does nothing else', async () => {
    const t = createHarness({ push: { configured: false } });
    await pairUntilApproval(t);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.extras.channels).toEqual(['approval', 'input', 'finished', 'interrupted']);
    expect(t.extras.registered).toBe(0);
    expect(t.extras.permissionAsked).toBe(0);
    expect(t.extras.tap).toBeNull();
  });

  it('says so on This phone', async () => {
    const t = createHarness({ push: { configured: false } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    click(t.root, 'This phone');
    await until(t.root, () => t.root.textContent?.includes('aren’t set up in this build') ?? false);
  });
});

describe('Push with the config', () => {
  it('asks once after the Mac allows the phone, never at launch', async () => {
    const t = createHarness({ push: { configured: true } });
    await pairUntilApproval(t);
    expect(t.extras.permissionAsked).toBe(0);
    t.mac.approve();
    await until(t.root, () => t.navigations.length > 0);
    expect(t.extras.permissionAsked).toBe(1);
  });

  it('opens the session a notification tap names, on its Mac', async () => {
    const t = createHarness({ push: { configured: true, permission: 'granted' }, mac: { sessions: SESSIONS, reachable: [TAILNET, 'http://100.88.1.7:3333'] } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    t.vault.set(`backend.${KASON_MBP.id}`, JSON.stringify({ host: 'api.aasc.work', deviceId: 'be-1', token: 'b'.repeat(43) }));
    await t.app.start();
    await until(t.root, () => t.extras.tap !== null && t.extras.registered === 1); // re-sent at launch, no prompt
    expect(t.extras.permissionAsked).toBe(0);
    t.extras.tap!({ data: { v: '1', kind: 'approval', sessionRef: 'sess-a' } });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations[0]).toMatch(/\/\?session=sess-a&tab=terminal$/);
  });

  it('ignores a malformed notification', async () => {
    const t = createHarness({ push: { configured: true, permission: 'granted' } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    await until(t.root, () => t.extras.tap !== null);
    t.extras.tap!({ data: { kind: 'approval' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(t.navigations).toEqual([]);
    expect(heading(t.root)).toBe('Your Macs');
  });
});
