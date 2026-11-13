import { afterEach, expect, it, vi } from 'vitest';
import { setProjectEditing, resetProjectEditing } from './projectEditGuard';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';
import { handleHostedSwitch, checkHostedEdition } from './hostedSwitch';
it('accepts only the exact parent and an allowed edition, then waits for the draft receipt', async () => {
  let saved!: () => void;
  const navigations: string[] = [];
  const deps = {
    origin: 'https://xclaude.dev',
    parent: window,
    check: async () => {},
    flush: () =>
      new Promise<void>((r) => {
        saved = r;
      }),
    navigate: (path: string) => navigations.push(path),
    reply: () => {},
  };
  const event = (origin: string, edition: string, source: Window | null = window) =>
    new MessageEvent('message', { origin, source, data: { type: 'aasc:hosted-switch', edition } });
  expect(await handleHostedSwitch(event('https://evil.test', 'full'), deps)).toBe(false);
  expect(await handleHostedSwitch(event(deps.origin, 'full', null), deps)).toBe(false);
  expect(await handleHostedSwitch(event(deps.origin, '../full'), deps)).toBe(false);
  const switching = handleHostedSwitch(event(deps.origin, 'full'), deps);
  expect(navigations).toEqual([]);
  await Promise.resolve();
  expect(saved).toBeTypeOf('function');
  saved();
  expect(await switching).toBe(true);
  expect(navigations).toEqual(['/ui/full/']);
});
it('keeps the current interface and reports a failed save', async () => {
  const navigations: string[] = [],
    messages: unknown[] = [];
  await handleHostedSwitch(
    new MessageEvent('message', {
      origin: 'https://xclaude.dev',
      source: window,
      data: { type: 'aasc:hosted-switch', edition: 'lite' },
    }),
    {
      origin: 'https://xclaude.dev',
      parent: window,
      check: async () => {},
      flush: async () => {
        throw Error('offline');
      },
      navigate: (p) => navigations.push(p),
      reply: (m) => messages.push(m),
    },
  );
  expect(navigations).toEqual([]);
  expect(messages).toEqual([{ type: 'aasc:hosted-switch-error', reason: 'save_failed' }]);
});

it('keeps the page when the other edition is unavailable', async () => {
  const navigations: string[] = [],
    messages: unknown[] = [];
  await handleHostedSwitch(
    new MessageEvent('message', {
      origin: 'https://xclaude.dev',
      source: window,
      data: { type: 'aasc:hosted-switch', edition: 'full' },
    }),
    {
      origin: 'https://xclaude.dev',
      parent: window,
      check: async () => {
        throw Error('edition_unavailable');
      },
      flush: async () => {},
      navigate: (p) => navigations.push(p),
      reply: (m) => messages.push(m),
    },
  );
  expect(navigations).toEqual([]);
  expect(messages).toEqual([{ type: 'aasc:hosted-switch-error', reason: 'edition_unavailable' }]);
});

afterEach(() => {
  resetProjectEditing();
  vi.unstubAllGlobals();
});
it('blocks a switch with unsaved project content and checks the target build before leaving', async () => {
  useSessionStore.setState({ sessions: new Map([['s', { sessionId: 's' } as Session]]) });
  const request = vi.fn(async () => new Response('Unavailable', { status: 503 }));
  vi.stubGlobal('fetch', request);
  setProjectEditing('s', 'file', true);
  await expect(checkHostedEdition('full')).rejects.toThrow('unsaved_files');
  expect(request).not.toHaveBeenCalled();
  setProjectEditing('s', 'file', false);
  await expect(checkHostedEdition('full')).rejects.toThrow('edition_unavailable');
  request.mockImplementation(
    async () => new Response('', { headers: { 'content-type': 'text/html' } }),
  );
  await expect(checkHostedEdition('full')).resolves.toBeUndefined();
});
