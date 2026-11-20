// DevicesSwitcher.search.test.tsx — the Switch part's search field (plan 18 §5.4): shown over seven computer rows,
// it filters the rows by the name shown.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { fleet, installWorld, pending, record, renderSwitcher, type World } from './DevicesSwitcher.fixtures';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const ACCOUNT = ['Mac mini', 'Studio iMac', 'Office NUC', 'Build box', 'VPS Sydney', 'MacBook Air'];
const LINKS = ['Lab PC', 'Garage Pi'];
const NO_MATCH = 'No computer matches “zzz”.';

let world: World;

beforeEach(() => {
  world = installWorld();
});

afterEach(() => {
  delete window.electronAPI;
  vi.clearAllMocks();
});

const field = () => screen.getByRole('textbox', { name: 'Search computers' }) as HTMLInputElement;
const noField = () => screen.queryByRole('textbox', { name: 'Search computers' });
const region = (name: string) => screen.queryByRole('region', { name });
const type = (text: string) => fireEvent.change(field(), { target: { value: text } });
const follows = (a: Node, b: Node) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
/** The names of the rows drawn, in order. */
const names = () => [...document.querySelectorAll('li [title]')].map((el) => el.textContent);

/** Every row drawn and the directory listed. */
async function drawn(rows: number): Promise<void> {
  await screen.findByRole('region', { name: 'This computer' });
  // This computer's own row is one more.
  await waitFor(() => expect(names()).toHaveLength(rows + 1));
}

describe('DevicesSwitcher — search', () => {
  it('has no search field at seven computer rows: this computer is not one of them', async () => {
    fleet(world, ACCOUNT, LINKS.slice(0, 1));
    renderSwitcher();
    await drawn(7);
    expect(noField()).toBeNull();
  });

  it('offers “Search computers” above the sections at eight', async () => {
    fleet(world, ACCOUNT, LINKS);
    renderSwitcher();
    await drawn(8);
    expect(field().value).toBe('');
    expect(follows(field(), region('This computer')!)).toBe(true);
    expect(follows(field(), region('My computers')!)).toBe(true);
  });

  it('counts account and link rows together, connected or not', async () => {
    // Five on the account that this computer never connected to, and three paired by link.
    fleet(world, ACCOUNT.slice(0, 5), [...LINKS, 'Den PC']);
    world.stored = world.stored.filter((c) => c.origin === 'link');
    renderSwitcher();
    await drawn(8);
    expect(field()).toBeTruthy();
  });

  it('filters the rows by name as it is typed, in any case, anywhere in the name', async () => {
    fleet(world, ACCOUNT, LINKS);
    renderSwitcher();
    await drawn(8);
    type('BOX');
    expect(names()).toEqual(['MacBook Pro', 'Build box']);
    type('ac');
    expect(names()).toEqual(['MacBook Pro', 'Mac mini', 'Studio iMac', 'MacBook Air']);
    type('  pi ');
    expect(names()).toEqual(['MacBook Pro', 'Garage Pi']);
  });

  it('searches the name shown: the one given here, not the account’s', async () => {
    fleet(world, ACCOUNT, LINKS);
    world.stored = world.stored.map((c) => (c.id === 'r-2' ? { ...c, name: 'Den server' } : c));
    renderSwitcher();
    await drawn(8);
    type('den');
    expect(names()).toEqual(['MacBook Pro', 'Den server']);
    type('office');
    expect(screen.getByRole('status')).toHaveTextContent('No computer matches “office”.');
  });

  it('draws no section that has no rows left, and keeps this computer', async () => {
    fleet(world, ACCOUNT, LINKS);
    renderSwitcher();
    await drawn(8);
    type('garage');
    expect(region('My computers')).toBeNull();
    expect(within(region('Paired by link')!).getByText('Garage Pi')).toBeTruthy();
    expect(region('This computer')).toBeTruthy();
    type('studio');
    expect(region('Paired by link')).toBeNull();
    // The heading still counts the account's computers, not the rows in view.
    expect(within(region('My computers')!).getByText('6 of 6 online')).toBeTruthy();
  });

  it('says one line when nothing matches, and the footer stays', async () => {
    fleet(world, ACCOUNT, LINKS);
    renderSwitcher();
    await drawn(8);
    expect(screen.queryByText(NO_MATCH)).toBeNull();
    type('zzz');
    expect(screen.getByRole('status')).toHaveTextContent(NO_MATCH);
    expect(region('My computers')).toBeNull();
    expect(region('Paired by link')).toBeNull();
    expect(names()).toEqual(['MacBook Pro']);
    expect(screen.getByRole('button', { name: '+ Add a computer by link' })).toBeTruthy();
  });

  it('clearing restores every row, by the clear button or by emptying the field', async () => {
    fleet(world, ACCOUNT, LINKS);
    renderSwitcher();
    await drawn(8);
    type('zzz');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
    expect(names()).toEqual(['MacBook Pro', ...ACCOUNT, ...LINKS]);
    expect(screen.queryByText(NO_MATCH)).toBeNull();
    type('box');
    type('');
    expect(names()).toEqual(['MacBook Pro', ...ACCOUNT, ...LINKS]);
  });

  it('a text of spaces filters nothing', async () => {
    fleet(world, ACCOUNT, LINKS);
    renderSwitcher();
    await drawn(8);
    type('   ');
    expect(names()).toEqual(['MacBook Pro', ...ACCOUNT, ...LINKS]);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('filters a link pairing’s waiting card with its row', async () => {
    fleet(world, ACCOUNT, LINKS);
    const waiting = record({ id: 'l-9', name: 'Loft PC', origin: 'link', backendDeviceId: undefined, status: 'pending', confirmCode: '482913' });
    world.api.add.mockImplementation(() => {
      world.stored = [...world.stored, waiting];
      return Promise.resolve({ ok: true, data: waiting });
    });
    world.answers = { 'l-9': pending() };
    renderSwitcher();
    await drawn(8);
    fireEvent.click(screen.getByRole('button', { name: '+ Add a computer by link' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing link' }), { target: { value: 'https://aasc.work/pair#x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    const card = () => screen.queryByText(/press Allow for this computer/);
    await waitFor(() => expect(card()).toBeTruthy());
    type('garage');
    expect(card()).toBeNull();
    type('loft');
    expect(card()).toBeTruthy();
    expect(names()).toEqual(['MacBook Pro', 'Loft PC']);
  });

  it('when the rows drop to seven the field goes, and its text filters nothing', async () => {
    fleet(world, ACCOUNT, LINKS);
    renderSwitcher();
    await drawn(8);
    type('pi');
    expect(names()).toEqual(['MacBook Pro', 'Garage Pi']);
    fireEvent.click(screen.getByRole('button', { name: 'More for Garage Pi' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(noField()).toBeNull());
    expect(names()).toEqual(['MacBook Pro', ...ACCOUNT, 'Lab PC']);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
