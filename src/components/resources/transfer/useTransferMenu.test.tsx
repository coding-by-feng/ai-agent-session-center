// useTransferMenu — the Projects row's Copy / Move items (Nov 27 2026): only in the Full desktop
// app (Electron main can send), only for a folder here; plus the "Moved to" line from one read.
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMovedForTests } from './movedProjects';
import { useTransferMenu } from './useTransferMenu';

const api = vi.hoisted(() => ({ moved: vi.fn() }));
vi.mock('@/lib/projectTransferApi', () => ({ projectTransferApi: api }));

const setBridge = (remotes: object | undefined) => {
  (window as unknown as { electronAPI?: unknown }).electronAPI = remotes ? { remotes } : undefined;
};

beforeEach(() => {
  resetMovedForTests();
  api.moved.mockReset().mockResolvedValue([
    {
      root: '/Users/me/app',
      computer: 'studio',
      destination: '~/app',
      at: new Date(2026, 10, 27, 12).getTime(),
    },
  ]);
});
afterEach(() => setBridge(undefined));

describe('useTransferMenu', () => {
  it('offers Copy and Move with the desktop bridge and a folder', async () => {
    setBridge({ projectTransferStart: vi.fn() });
    const { result } = renderHook(() => useTransferMenu('/Users/me/app'));
    expect(result.current.menuItems.map((i) => i.label)).toEqual([
      'Copy to computer…',
      'Move to computer…',
    ]);
    await waitFor(() => expect(result.current.movedLine).toBe('Moved to studio · Nov 27'));
  });

  it('reads the Move markers once for every row', async () => {
    setBridge({ projectTransferStart: vi.fn() });
    const a = renderHook(() => useTransferMenu('/Users/me/app'));
    const b = renderHook(() => useTransferMenu('/Users/me/other'));
    await waitFor(() => expect(a.result.current.movedLine).toBeDefined());
    expect(b.result.current.movedLine).toBeUndefined();
    expect(api.moved).toHaveBeenCalledTimes(1);
  });

  it('hides the items without the desktop bridge', () => {
    setBridge(undefined);
    const { result } = renderHook(() => useTransferMenu('/Users/me/app'));
    expect(result.current.menuItems).toEqual([]);
    expect(api.moved).not.toHaveBeenCalled();
  });

  it('hides the items when the bridge has no transfer call (an older app)', () => {
    setBridge({ list: vi.fn() });
    const { result } = renderHook(() => useTransferMenu('/Users/me/app'));
    expect(result.current.menuItems).toEqual([]);
  });

  it('hides the items for a row with no folder here', () => {
    setBridge({ projectTransferStart: vi.fn() });
    const { result } = renderHook(() => useTransferMenu(null));
    expect(result.current.menuItems).toEqual([]);
  });
});
