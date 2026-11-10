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
    for (const id of ['switchTabTerminal', 'switchTabCommands', 'switchTabProject', 'switchTabQueue', 'terminalToggleAutoScroll', 'switchSession1']) {
      expect(ids).toContain(id);
    }
  });

  it('binds the AI popup window\'s keys, which its buttons name', () => {
    for (const id of ['floatMinimize', 'floatMaximize', 'floatClose']) expect(ids).toContain(id);
  });

  it('binds nothing Lite leaves out', () => {
    for (const id of ['terminalClone', 'terminalFork', 'terminalPopOut', 'terminalRefresh', 'switchTabNotes']) {
      expect(ids).not.toContain(id);
    }
  });
});
