// remoteHandlersSender.test.ts — who may call remote:*. Full and Lite keep the local dashboard rule; a Client passes
// its home page's rule, and neither accepts the other's page or a remote's.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent-test-path', isPackaged: false, on: vi.fn() },
  dialog: {},
  crashReporter: {},
  ipcMain: { handle: (channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => handlers.set(channel, fn) },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  session: {},
  shell: {},
}));

const NOT_THIS_APP = 'Only this app’s own window can manage remote computers.';
const event = (url: string) => ({ senderFrame: { url } }) as unknown as IpcMainInvokeEvent;

async function registered(options?: { isAppSender?: (url: string) => boolean }) {
  handlers.clear();
  vi.resetModules();
  const { registerRemoteHandlers } = await import('../electron/ipc/remoteHandlers.js');
  registerRemoteHandlers(options);
  return (url: string) => handlers.get('remote:add')!(event(url), 'not a link') as Promise<{ ok: boolean; error?: string }>;
}

const CHANNELS: Array<[string, unknown[]]> = [
  ['remote:add', ['not a link']],
  ['remote:check', ['abc']],
  ['remote:open', ['abc']],
  ['remote:remove', ['abc']],
  ['remote:rename', ['abc', 'name']],
];

describe('the sender rule', () => {
  beforeEach(() => handlers.clear());

  describe.each(CHANNELS)('%s', (channel, args) => {
    it.each([
      ['a remote page', { senderFrame: { url: 'http://192.168.1.20:3334/' } }],
      ['the local dashboard, in a Client', { senderFrame: { url: 'http://localhost:3333/' } }],
      ['a frame already gone', { senderFrame: null }],
      ['no frame at all', {}],
    ])('refuses %s', async (_name, sender) => {
      const { isClientHomeSenderUrl } = await import('../electron/remote/clientUi.js');
      await registered({ isAppSender: isClientHomeSenderUrl });
      const answer = await handlers.get(channel)!(sender as unknown as IpcMainInvokeEvent, ...args) as { error?: string };
      expect(answer.error).toBe(NOT_THIS_APP);
    });
  });

  it.each([
    ['a remote page', { senderFrame: { url: 'http://192.168.1.20:3334/' } }],
    ['a frame already gone', { senderFrame: null }],
  ])('remote:list gives %s an empty list', async (_name, sender) => {
    const { isClientHomeSenderUrl } = await import('../electron/remote/clientUi.js');
    await registered({ isAppSender: isClientHomeSenderUrl });
    expect(await handlers.get('remote:list')!(sender as unknown as IpcMainInvokeEvent)).toEqual([]);
  });

  it('stays the local dashboard when nothing is passed (Full and Lite)', async () => {
    const add = await registered();
    expect((await add('http://localhost:3333/')).error).not.toBe(NOT_THIS_APP);
    expect((await add('aasc-client://home/')).error).toBe(NOT_THIS_APP);
    expect((await add('http://192.168.1.20:3334/')).error).toBe(NOT_THIS_APP);
  });

  it('is the one a Client passes, and then a localhost page is refused', async () => {
    const { isClientHomeSenderUrl } = await import('../electron/remote/clientUi.js');
    const add = await registered({ isAppSender: isClientHomeSenderUrl });
    expect((await add('aasc-client://home/')).error).not.toBe(NOT_THIS_APP);
    expect((await add('http://localhost:3333/')).error).toBe(NOT_THIS_APP);
    expect((await add('http://192.168.1.20:3334/')).error).toBe(NOT_THIS_APP);
  });
});
