// DevicesSwitcher.fixtures.tsx — a fake `window.electronAPI.remotes` with the account channels, for the switcher's tests.
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import DevicesSwitcher from './DevicesSwitcher';
import type {
  AccountDirectory, AccountMachine, RemoteComputer, RemoteComputerCheck, RemoteComputersAPI, RemoteResult,
} from '@/types/electron';

export function record(over: Partial<RemoteComputer>): RemoteComputer {
  return {
    id: 'r-mini', name: 'Mac mini', lan: '192.168.4.30', tailnet: null, port: 3333, status: 'active', confirmCode: null,
    addedAt: 0, lastSeenAt: null, origin: 'account', backendDeviceId: 'd-mini', ...over,
  };
}

export function linked(over: Partial<RemoteComputer> = {}): RemoteComputer {
  return record({ id: 'r-nuc', name: 'Old NUC', origin: 'link', backendDeviceId: undefined, ...over });
}

export function machine(over: Partial<AccountMachine>): AccountMachine {
  return {
    deviceId: 'd-mini', name: 'Mac mini', platform: 'macos', edition: 'full', appVersion: '2.11.0', lastUsedAt: null,
    current: false, connectable: true, relation: 'self',
    addresses: { lan: '192.168.4.30', tailnet: null, publicAddress: null, port: 3333 }, record: null, ...over,
  };
}

export const HERE = machine({ deviceId: 'd-here', name: 'MacBook Pro', current: true, addresses: null });

export const online = (over: Partial<RemoteComputerCheck> = {}): RemoteComputerCheck =>
  ({ state: 'online', via: 'tailnet', sharedSessions: 4, message: null, ...over });
export const offline = (message: string | null = null): RemoteComputerCheck =>
  ({ state: 'offline', via: null, sharedSessions: null, message });
/** Something answered at the machine's address and proved nothing: what a removal on the machine looks like. */
export const unproved = (name: string): RemoteComputerCheck =>
  ({ ...offline(`Something else answered at ${name}’s address.`), unproved: true });
export const pending = (): RemoteComputerCheck => ({ state: 'pending', via: null, sharedSessions: null, message: null });

export function ok<T>(data: T): Promise<RemoteResult<T>> {
  return Promise.resolve({ ok: true, data });
}

export function refused<T>(error: string): Promise<RemoteResult<T>> {
  return Promise.resolve({ ok: false, error });
}

export function directoryOf(...machines: AccountMachine[]): AccountDirectory {
  return { state: 'ok', machines };
}

type Mocked = { [K in keyof Required<RemoteComputersAPI>]: ReturnType<typeof vi.fn> };

/** What the fake main process holds; a test changes it and the next call answers from it. */
export interface World {
  stored: RemoteComputer[];
  answers: Record<string, RemoteComputerCheck>;
  directory: AccountDirectory;
  api: Mocked;
}

export function installWorld(): World {
  const world: World = {
    stored: [],
    answers: {},
    directory: directoryOf(HERE),
    api: undefined as unknown as Mocked,
  };
  world.api = {
    list: vi.fn(() => Promise.resolve(world.stored)),
    check: vi.fn((id: string) => ok(world.answers[id] ?? online())),
    add: vi.fn(),
    open: vi.fn(() => ok(null)),
    remove: vi.fn((id: string) => {
      world.stored = world.stored.filter((c) => c.id !== id);
      return ok({ unpairedRemotely: true });
    }),
    rename: vi.fn((id: string, name: string) => {
      world.stored = world.stored.map((c) => (c.id === id ? { ...c, name } : c));
      return ok(world.stored.find((c) => c.id === id));
    }),
    accountMachines: vi.fn(() => ok(world.directory)),
    accountConnect: vi.fn(),
    projectTransferStart: vi.fn(),
    projectTransferCancel: vi.fn(),
    onProjectTransferProgress: vi.fn(() => () => {}),
  };
  window.electronAPI = { remotes: world.api as unknown as RemoteComputersAPI } as typeof window.electronAPI;
  return world;
}

/**
 * The account's other computers by name, each connected (`r-0`, `r-1`, … for machines `d-0`, `d-1`, …), then
 * computers paired by link (`l-0`, …). Every check answers online unless the test says otherwise.
 */
export function fleet(world: World, account: readonly string[], links: readonly string[] = []): void {
  world.directory = directoryOf(HERE, ...account.map((name, i) => machine({ deviceId: `d-${i}`, name })));
  world.stored = [
    ...account.map((name, i) => record({ id: `r-${i}`, name, backendDeviceId: `d-${i}` })),
    ...links.map((name, i) => linked({ id: `l-${i}`, name })),
  ];
}

/**
 * `beside`: anything else to draw inside the same router (a test's own location probe). `focusOnOpen`: draw it as
 * the panel does when it has just opened on Switch.
 */
export function renderSwitcher(onLeave: () => void = () => {}, beside: ReactNode = null, focusOnOpen = false) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <DevicesSwitcher onLeave={onLeave} focusOnOpen={focusOnOpen} />
      {beside}
    </MemoryRouter>,
  );
}
