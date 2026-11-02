// Global search lands on a hit inside CONVERSATION, which Lite hides, so the Lite desktop has no key
// for it and the keystroke reaches the terminal. A phone opens the search from its own screens.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));

import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useUiStore } from '@/stores/uiStore';

function Harness() {
  useKeyboardShortcuts();
  return null;
}

describe('global search in the Lite build', () => {
  beforeEach(() => {
    useUiStore.setState({ activeModal: null });
  });

  it('has no Cmd/Ctrl+Shift+F', () => {
    render(<Harness />);
    const untouched = fireEvent.keyDown(document.body, { key: 'f', shiftKey: true, metaKey: true });
    expect(useUiStore.getState().activeModal).toBeNull();
    expect(untouched).toBe(true);
  });
});
