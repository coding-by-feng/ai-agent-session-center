// shortcutKeys.lite.test.ts — Lite has no binding for what it leaves out, so the key reaches the
// terminal and neither shortcut list names it.
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));

import { buildBindings } from './shortcutKeys';

describe('buildBindings in the Lite build', () => {
  const ids = buildBindings().map((binding) => binding.actionId as string);

  it('binds what Lite keeps', () => {
    for (const id of ['switchTabTerminal', 'switchTabCommands', 'switchTabProject', 'switchTabAiPopups', 'switchTabQueue', 'terminalToggleAutoScroll', 'switchSession1']) {
      expect(ids).toContain(id);
    }
  });

  it('binds the AI popup window\'s keys, which its buttons name', () => {
    for (const id of ['floatMinimize', 'floatMaximize', 'floatClose']) expect(ids).toContain(id);
  });

  it('binds nothing Lite leaves out', () => {
    for (const id of ['terminalClone', 'terminalFork', 'terminalPopOut', 'terminalRefresh', 'switchTabAgents']) {
      expect(ids).not.toContain(id);
    }
  });

  // The devices switcher is in Lite (plan 18), so its key is too: where the app offers the account's computers.
  it('binds the devices switcher’s key in the Lite desktop app, and nowhere it has no switcher', () => {
    expect(ids).not.toContain('switchDevice');
    window.electronAPI = { remotes: { accountMachines: () => Promise.resolve({ ok: true, data: { state: 'signed-out' } }) } } as unknown as typeof window.electronAPI;
    try {
      const bound = buildBindings().find((binding) => (binding.actionId as string) === 'switchDevice');
      expect(bound?.combo).not.toBeNull();
      expect(bound?.label).toBe('Switch computer');
    } finally {
      delete window.electronAPI;
    }
  });
});
