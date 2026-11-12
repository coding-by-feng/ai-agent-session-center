// @vitest-environment jsdom
// "Use the home network?" (Nov 10 2026): a Mac paired with the home network off, found answering on it (the phone is
// at home), is offered it once. Away from home nothing is asked, and nothing is waited for.
import { afterEach, describe, expect, it } from 'vitest';
import { LAN_OFFERED_KEY } from './lanOffer';
import { loadMacs } from './savedMacs';
import { click, createHarness, heading, KASON_MBP, LAN, seedMac, STUDIO, TAILNET, until, type HarnessOptions } from './testing/shellHarness';

afterEach(() => document.body.replaceChildren());

async function launch(opts: HarnessOptions, mac = KASON_MBP) {
  const t = createHarness(opts);
  await seedMac(t, mac);
  void t.app.start();
  return t;
}

const AT_HOME: HarnessOptions = { mac: { reachable: [LAN, TAILNET] } };
const offered = async (t: ReturnType<typeof createHarness>) => JSON.parse((await t.deps.store.get(LAN_OFFERED_KEY)) ?? '[]');

describe('the home-network offer', () => {
  it('at home with the home network off, asks once before opening', async () => {
    const t = await launch(AT_HOME);
    await until(t.root, () => heading(t.root) === 'Use the home network?');
    expect(t.root.textContent).toContain('192.168.1.20');
    expect(t.navigations).toEqual([]);
  });

  it('"Use the home network" turns it on and opens the Mac over it', async () => {
    const t = await launch(AT_HOME);
    await until(t.root, () => heading(t.root) === 'Use the home network?');
    click(t.root, 'Use the home network');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${LAN}/`]);
    expect((await loadMacs(t.deps.store))[0]).toMatchObject({ lanAllowed: true });
    expect(t.allowed.at(-1)).toContain(LAN);
    expect(await offered(t)).toEqual([KASON_MBP.id]);
  });

  it('"Not now" opens it over Tailscale, keeps the home network off and does not ask again', async () => {
    const t = await launch(AT_HOME);
    await until(t.root, () => heading(t.root) === 'Use the home network?');
    click(t.root, 'Not now');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect((await loadMacs(t.deps.store))[0]).toMatchObject({ lanAllowed: false });
    expect(await offered(t)).toEqual([KASON_MBP.id]);

    const again = await launch({ ...AT_HOME, store: { [LAN_OFFERED_KEY]: JSON.stringify([KASON_MBP.id]) } });
    await until(again.root, () => again.navigations.length > 0);
    expect(again.navigations).toEqual([`${TAILNET}/`]);
  });

  it('away from home (the home address does not answer) asks nothing and keeps the offer for later', async () => {
    const t = await launch({ mac: { reachable: [TAILNET] } });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
    expect(await offered(t)).toEqual([]);
  });

  it('is not shown when the home network is already on: the Mac opens over it', async () => {
    const t = await launch(AT_HOME, { ...KASON_MBP, lanAllowed: true });
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${LAN}/`]);
  });

  it('is not shown for a Mac with no home address', async () => {
    const t = await launch({ mac: { reachable: [`http://${STUDIO.tailnet}:3333`] } }, STUDIO);
    await until(t.root, () => t.navigations.length > 0);
    expect(heading(t.root)).not.toBe('Use the home network?');
  });
});
