// DevicesSwitcher.keys.test.tsx — the Switch part from the keyboard (plan 18 §5.4): where focus lands when the
// panel opens, and ↑ ↓ Home End between the rows' primary actions. Everything else keeps its own keys.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEVICES_SWITCH_EVENT } from '@/lib/devicesSwitcher';
import { buildBindings, isMac } from '@/lib/shortcutKeys';
import { useShortcutStore } from '@/stores/shortcutStore';
import type { AccountDirectory, RemoteResult } from '@/types/electron';
import {
  HERE, directoryOf, fleet, installWorld, linked, machine, ok, pending, record, renderSwitcher, type World,
} from './DevicesSwitcher.fixtures';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const NINE = ['Mac mini', 'Studio iMac', 'Office NUC', 'Build box', 'VPS Sydney', 'MacBook Air', 'Render node'];
const LINKS = ['Lab PC', 'Garage Pi'];

let world: World;

beforeEach(() => {
  world = installWorld();
});

afterEach(() => {
  delete window.electronAPI;
  vi.clearAllMocks();
});

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const field = () => screen.getByRole('textbox', { name: 'Search computers' }) as HTMLInputElement;
const focused = () => document.activeElement as HTMLElement;
/** Press a key on whatever has focus; false when something took it (preventDefault). */
const press = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(focused(), { key, ...init });

/** Three rows with an action each: an account computer to connect, one connected, one paired by link. */
function three(): void {
  world.directory = directoryOf(HERE, machine({}), machine({ deviceId: 'd-vps', name: 'VPS' }));
  world.stored = [record({ id: 'r-vps', name: 'VPS', backendDeviceId: 'd-vps' }), linked()];
}

async function threeDrawn(): Promise<void> {
  three();
  renderSwitcher();
  await waitFor(() => expect(button('Open VPS').disabled).toBe(false));
  await screen.findByRole('button', { name: 'Connect Mac mini' });
}

describe('DevicesSwitcher — where focus lands when the panel opens on Switch', () => {
  it('goes to the search field when it is shown', async () => {
    fleet(world, NINE, LINKS);
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(field()));
  });

  it('goes to the first row’s primary action otherwise', async () => {
    three();
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(button('Connect Mac mini')));
  });

  it('skips a row that has no action to press', async () => {
    world.directory = directoryOf(HERE, machine({ connectable: false }), machine({ deviceId: 'd-vps', name: 'VPS' }));
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(button('Connect VPS')));
  });

  it('with no rows, goes to the part’s first control once the account has answered', async () => {
    world.directory = { state: 'signed-out', machines: [] };
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(button('Open AASC Cloud')));
  });

  it('moves no focus when the part is not an opening (the person came back to it by its tab)', async () => {
    three();
    renderSwitcher();
    await screen.findByRole('button', { name: 'Connect Mac mini' });
    await waitFor(() => expect(button('Open VPS').disabled).toBe(false));
    expect(focused()).toBe(document.body);
  });

  describe('when the account’s computers arrive after the rows already drawn', () => {
    let answer: (directory: AccountDirectory) => void;

    beforeEach(() => {
      world.stored = [linked()];
      world.api.accountMachines.mockImplementation(() => new Promise<RemoteResult<AccountDirectory>>((resolve) => {
        answer = (data) => resolve({ ok: true, data });
      }));
    });

    it('focus goes to what is drawn first, then once more to the row that became the first', async () => {
      renderSwitcher(undefined, null, true);
      await waitFor(() => expect(focused()).toBe(button('Open Old NUC')));
      await act(async () => answer(directoryOf(HERE, machine({}))));
      await waitFor(() => expect(focused()).toBe(button('Connect Mac mini')));
    });

    it('focus the person has moved since is left alone', async () => {
      renderSwitcher(undefined, null, true);
      await waitFor(() => expect(focused()).toBe(button('Open Old NUC')));
      button('More for Old NUC').focus();
      await act(async () => answer(directoryOf(HERE, machine({}))));
      await screen.findByRole('button', { name: 'Connect Mac mini' });
      expect(focused()).toBe(button('More for Old NUC'));
    });

    it('is aimed once: a later change of the list moves nothing', async () => {
      renderSwitcher(undefined, null, true);
      await waitFor(() => expect(focused()).toBe(button('Open Old NUC')));
      await act(async () => answer(directoryOf(HERE, machine({}))));
      await waitFor(() => expect(focused()).toBe(button('Connect Mac mini')));
      // Connect answers a record waiting for Allow: the row is redrawn with Dismiss, and focus follows the row.
      const waiting = record({ status: 'pending', confirmCode: '482913' });
      world.answers = { 'r-mini': pending() };
      world.api.accountConnect.mockImplementation(() => {
        world.stored = [...world.stored, waiting];
        return ok(waiting);
      });
      fireEvent.click(button('Connect Mac mini'));
      await waitFor(() => expect(focused()).toBe(button('Dismiss Mac mini')));
    });
  });
});

describe('DevicesSwitcher — ↑ ↓ Home End between the rows’ primary actions', () => {
  it('↓ and ↑ move through every section in the order drawn, and stop at the ends', async () => {
    await threeDrawn();
    button('Connect Mac mini').focus();
    expect(press('ArrowDown')).toBe(false);
    expect(focused()).toBe(button('Open VPS'));
    press('ArrowDown');
    expect(focused()).toBe(button('Open Old NUC'));
    // No wrapping: ↓ on the last row and ↑ on the first stay put (and still do not scroll the panel).
    expect(press('ArrowDown')).toBe(false);
    expect(focused()).toBe(button('Open Old NUC'));
    press('ArrowUp');
    press('ArrowUp');
    expect(focused()).toBe(button('Connect Mac mini'));
    expect(press('ArrowUp')).toBe(false);
    expect(focused()).toBe(button('Connect Mac mini'));
  });

  it('Home and End go to the first and the last', async () => {
    await threeDrawn();
    button('Open VPS').focus();
    expect(press('End')).toBe(false);
    expect(focused()).toBe(button('Open Old NUC'));
    expect(press('Home')).toBe(false);
    expect(focused()).toBe(button('Connect Mac mini'));
  });

  it('from the search field ↓ goes to the first row, and ↑ from the first row goes back to the field', async () => {
    fleet(world, NINE, LINKS);
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(field()));
    await waitFor(() => expect(button('Open Mac mini').disabled).toBe(false));
    expect(press('ArrowDown')).toBe(false);
    expect(focused()).toBe(button('Open Mac mini'));
    expect(press('ArrowUp')).toBe(false);
    expect(focused()).toBe(field());
    // Home on a row is the first row, not the field.
    button('Open Garage Pi').focus();
    press('Home');
    expect(focused()).toBe(button('Open Mac mini'));
    press('End');
    expect(focused()).toBe(button('Open Garage Pi'));
  });

  it('the search field keeps ↑, Home and End for its own caret, and ↓ when no row is left', async () => {
    fleet(world, NINE, LINKS);
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(field()));
    for (const key of ['ArrowUp', 'Home', 'End']) {
      expect(press(key)).toBe(true);
      expect(focused()).toBe(field());
    }
    fireEvent.change(field(), { target: { value: 'zzz' } });
    expect(press('ArrowDown')).toBe(true);
    expect(focused()).toBe(field());
  });

  it('moves among the rows the search left', async () => {
    fleet(world, NINE, LINKS);
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(field()));
    await waitFor(() => expect(button('Open Mac mini').disabled).toBe(false));
    fireEvent.change(field(), { target: { value: 'mac' } });
    press('ArrowDown');
    expect(focused()).toBe(button('Open Mac mini'));
    press('ArrowDown');
    expect(focused()).toBe(button('Open Studio iMac'));
    press('ArrowDown');
    expect(focused()).toBe(button('Open MacBook Air'));
    press('ArrowDown');
    expect(focused()).toBe(button('Open MacBook Air'));
  });

  it('passes over a row whose action cannot be pressed, and one that is being renamed', async () => {
    three();
    // Paired by link and still waiting for Allow: its Open is off.
    world.stored = [...world.stored, linked({ id: 'r-loft', name: 'Loft PC', status: 'pending', confirmCode: '482913' }), linked({ id: 'r-den', name: 'Den PC' })];
    world.answers = { 'r-loft': pending() };
    renderSwitcher();
    await waitFor(() => expect(button('Open VPS').disabled).toBe(false));
    expect(button('Open Loft PC').disabled).toBe(true);
    button('Open Old NUC').focus();
    press('ArrowDown');
    expect(focused()).toBe(button('Open Den PC'));
    // Renaming VPS: its row has a name field in Open's place.
    fireEvent.click(button('More for VPS'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    await screen.findByRole('textbox', { name: 'Computer name' });
    button('Connect Mac mini').focus();
    press('ArrowDown');
    expect(focused()).toBe(button('Open Old NUC'));
  });

  it('leaves an arrow held with a modifier to whoever owns that key', async () => {
    await threeDrawn();
    button('Connect Mac mini').focus();
    for (const mod of [{ altKey: true, metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]) {
      expect(press('ArrowDown', mod)).toBe(true);
      expect(focused()).toBe(button('Connect Mac mini'));
    }
  });

  it('Enter and Space press the focused button, as on any button', async () => {
    const user = userEvent.setup();
    await threeDrawn();
    button('Connect Mac mini').focus();
    press('ArrowDown');
    expect(press('Enter')).toBe(true);
    expect(press(' ')).toBe(true);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(world.api.open).toHaveBeenCalledTimes(1));
    await user.keyboard(' ');
    await waitFor(() => expect(world.api.open).toHaveBeenCalledTimes(2));
    expect(world.api.open).toHaveBeenCalledWith('r-vps');
  });
});

describe('DevicesSwitcher — arrow keys do nothing while something else is being used', () => {
  const KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  /** Every key is left alone: not taken, and focus where it was. */
  function inert(): void {
    const at = focused();
    for (const key of KEYS) {
      expect(press(key)).toBe(true);
      expect(focused()).toBe(at);
    }
  }

  it('a rename field, and its Save and Cancel', async () => {
    await threeDrawn();
    fireEvent.click(button('More for VPS'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const name = await screen.findByRole('textbox', { name: 'Computer name' });
    name.focus();
    inert();
    button('Cancel').focus();
    inert();
  });

  it('the pairing-link form: its field and its buttons', async () => {
    await threeDrawn();
    fireEvent.click(button('+ Add a computer by link'));
    const link = screen.getByRole('textbox', { name: 'Pairing link' });
    link.focus();
    inert();
    fireEvent.change(link, { target: { value: 'https://aasc.work/pair#x' } });
    button('Pair').focus();
    inert();
    button('Cancel').focus();
    inert();
  });

  it('the ⋯ button of a row', async () => {
    await threeDrawn();
    button('More for VPS').focus();
    inert();
  });

  it('the open ⋯ menu, whose arrows are its own', async () => {
    await threeDrawn();
    fireEvent.click(button('More for VPS'));
    const rename = await screen.findByRole('menuitem', { name: 'Rename' });
    const remove = screen.getByRole('menuitem', { name: 'Remove…' });
    await waitFor(() => expect(focused()).toBe(rename));
    press('ArrowDown');
    expect(focused()).toBe(remove);
    press('End');
    expect(focused()).toBe(remove);
    press('Home');
    expect(focused()).toBe(rename);
    press('ArrowUp');
    // The menu wraps; the rows never took the key.
    expect(focused()).toBe(remove);
  });

  it('the footer’s buttons and a section’s notice', async () => {
    await threeDrawn();
    button('+ Add a computer by link').focus();
    inert();
    screen.getByRole('link', { name: 'Manage devices…' }).focus();
    inert();
  });
});

describe('DevicesSwitcher — the switchDevice key in the search field', () => {
  const KEY = isMac ? { key: 's', shiftKey: true, metaKey: true } : { key: 'S', shiftKey: true, ctrlKey: true };
  let asked = 0;
  const onAsk = () => { asked += 1; };

  beforeEach(() => {
    asked = 0;
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    document.addEventListener(DEVICES_SWITCH_EVENT, onAsk);
  });

  afterEach(() => document.removeEventListener(DEVICES_SWITCH_EVENT, onAsk));

  it('asks the panel to close: the app’s shortcuts leave a text field its keys, and this field is where the key put focus', async () => {
    fleet(world, NINE, LINKS);
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(field()));
    expect(press(KEY.key, KEY)).toBe(false);
    expect(asked).toBe(1);
    // Typing is typing.
    expect(press('s')).toBe(true);
    expect(asked).toBe(1);
  });

  it('never takes a key that types: rebound to a plain letter, the letter still goes into the field', async () => {
    fleet(world, NINE, LINKS);
    useShortcutStore.getState().rebind('switchDevice' as never, { key: 'm' });
    renderSwitcher(undefined, null, true);
    await waitFor(() => expect(focused()).toBe(field()));
    expect(press('m')).toBe(true);
    expect(press('M', { shiftKey: true })).toBe(true);
    expect(asked).toBe(0);
    // A key that types nothing is still the shortcut's: a function key, or a letter with Cmd or Ctrl.
    useShortcutStore.getState().rebind('switchDevice' as never, { key: 'F6' });
    expect(press('F6')).toBe(false);
    expect(asked).toBe(1);
  });
});
