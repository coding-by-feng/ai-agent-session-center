// @vitest-environment jsdom
// Nov 27 2026: the list of computers as a switcher. A computer's page (the Sessions host line, More → Switch AASC)
// opens `/?tap=1&switch=1`: the list is headed "Your computers", the computer used last is marked "Using now" and the
// bar goes back to it. Every row says whether it answered (each path probed at once, given up after REACH_MS); a row
// with no answer yet says nothing, never "Offline". The account's computers not on this phone yet are probed the same
// way, on the addresses the account lists.
import { afterEach, describe, expect, it } from 'vitest';
import { LAST_MAC_KEY } from './savedMacs';
import { buttonNamed, click, createHarness, heading, KASON_MBP, seedMac, STUDIO, TAILNET, until } from './testing/shellHarness';

afterEach(() => {
  document.body.replaceChildren();
});

const text = (t: { root: HTMLElement }) => t.root.textContent ?? '';
const rowOf = (root: HTMLElement, name: string): HTMLElement | null =>
  Array.from(root.querySelectorAll<HTMLElement>('.mac')).find((r) => r.querySelector('.mac-name')?.textContent === name) ?? null;
const reachOf = (root: HTMLElement, name: string): string | null =>
  rowOf(root, name)?.querySelector('[data-reach]')?.getAttribute('data-reach') ?? null;

/** Kason-MBP answers on Tailscale; Studio (100.88.1.7) answers nowhere. */
async function twoComputers(search: string, last: string | null = KASON_MBP.id) {
  const t = createHarness({ search, store: last ? { [LAST_MAC_KEY]: last } : {}, mac: { reachable: [TAILNET] } });
  await seedMac(t, KASON_MBP);
  await seedMac(t, STUDIO);
  await t.app.start();
  return t;
}

describe('the list of computers as a switcher', () => {
  it('is headed Your computers, marks the computer used last and goes back to it', async () => {
    const t = await twoComputers('?tap=1&switch=1');
    expect(heading(t.root)).toBe('Your computers');
    expect(rowOf(t.root, 'Kason-MBP')?.textContent).toContain('Using now');
    expect(rowOf(t.root, 'Studio')?.textContent).not.toContain('Using now');
    expect(t.navigations).toEqual([]); // the list stays: nothing opens by itself

    click(t.root, 'Back to Kason-MBP');
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual([`${TAILNET}/`]);
  });

  it('opens another computer from its row', async () => {
    const t = createHarness({ search: '?tap=1&switch=1', store: { [LAST_MAC_KEY]: KASON_MBP.id }, mac: { reachable: [TAILNET, 'http://100.88.1.7:3333'] } });
    await seedMac(t, KASON_MBP);
    await seedMac(t, STUDIO);
    await t.app.start();
    click(t.root, /^Studio/);
    await until(t.root, () => t.navigations.length > 0);
    expect(t.navigations).toEqual(['http://100.88.1.7:3333/']);
  });

  it('has no back bar and marks nothing without switch=1 (the plain list)', async () => {
    const t = await twoComputers('?tap=1');
    expect(heading(t.root)).toBe('Your computers');
    expect(buttonNamed(t.root, /^Back to/)).toBeNull();
    expect(text(t)).not.toContain('Using now');
    expect(buttonNamed(t.root, 'Pair another computer')).not.toBeNull();
  });

  it('has no back bar when no computer was used yet', async () => {
    const t = await twoComputers('?tap=1&switch=1', null);
    expect(buttonNamed(t.root, /^Back to/)).toBeNull();
    expect(text(t)).not.toContain('Using now');
  });

  // A row with no answer yet says nothing (macReach.test.ts: offline only after REACH_MS).
  it('says which computers answered', async () => {
    const t = await twoComputers('?tap=1&switch=1');
    await until(t.root, () => reachOf(t.root, 'Kason-MBP') === 'online' && reachOf(t.root, 'Studio') === 'offline', 4_000);
    const dot = rowOf(t.root, 'Studio')!.querySelector('[data-reach]')!;
    expect(dot.getAttribute('role')).toBe('img');
    expect(dot.getAttribute('aria-label')).toBe('Offline');
    // The dot is inside the row's button, so its name says it; its text stays the name and the path.
    expect(rowOf(t.root, 'Studio')!.querySelector('.mac-open')!.contains(dot)).toBe(true);
    expect(dot.textContent).toBe('');
  });
});

describe('the account’s computers in the switcher', () => {
  async function signedIn() {
    const t = createHarness({ authSession: true, mac: { reachable: [TAILNET] } });
    await t.app.start();
    click(t.root, 'Sign in');
    await until(t.root, () => heading(t.root) === 'Check this code');
    click(t.root, 'Continue');
    await until(t.root, () => buttonNamed(t.root, 'Connect to Kason-MBP') !== null);
    return t;
  }

  it('says an account computer answered, next to its Connect', async () => {
    const t = await signedIn();
    expect(heading(t.root)).toBe('Your computers');
    await until(t.root, () => reachOf(t.root, 'Kason-MBP') === 'online', 4_000);
  });
});
