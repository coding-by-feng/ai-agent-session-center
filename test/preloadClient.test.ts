// preloadClient.test.ts — the one thing a Client's home page hears from the main process. The channel is a string in two
// files, and a typo there leaves the list quietly out of date with every test green.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    listeners,
    exposed: {} as Record<string, unknown>,
    ipcRenderer: {
      invoke: vi.fn(),
      on: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.set(channel, (listeners.get(channel) ?? new Set()).add(listener));
      },
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        listeners.get(channel)?.delete(listener);
      },
    },
  };
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { fake.exposed[name] = api; } },
  ipcRenderer: fake.ipcRenderer,
}));

describe('onHomeShown', () => {
  it('passes the signal on, with nothing from IPC, and can stop', async () => {
    await import('../electron/preloadClient.js');
    const { onHomeShown } = fake.exposed.electronAPI as { onHomeShown: (listener: (...args: unknown[]) => void) => () => void };
    const listener = vi.fn();
    const stop = onHomeShown(listener);
    const subscribed = fake.listeners.get('client:home-shown');
    expect(subscribed?.size).toBe(1);
    subscribed!.forEach((forward) => forward({ sender: 'the IPC event, which reaches the main process' }));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith();
    stop();
    expect(subscribed?.size).toBe(0);
  });

  it('listens on the channel the main process sends', () => {
    const main = readFileSync(new URL('../electron/clientMain.ts', import.meta.url), 'utf8');
    expect(main).toContain("send('client:home-shown')");
  });
});
