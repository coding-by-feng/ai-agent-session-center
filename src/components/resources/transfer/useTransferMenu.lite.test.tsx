// useTransferMenu in the Lite build: Copy / Move to computer is Full-only (lib/edition.ts).
import { renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTransferMenu } from './useTransferMenu';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
const api = vi.hoisted(() => ({ moved: vi.fn(async () => []) }));
vi.mock('@/lib/projectTransferApi', () => ({ projectTransferApi: api }));

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

it('hides the items in Lite even with the desktop bridge', () => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    remotes: { projectTransferStart: vi.fn() },
  };
  const { result } = renderHook(() => useTransferMenu('/Users/me/app'));
  expect(result.current.menuItems).toEqual([]);
  expect(api.moved).not.toHaveBeenCalled();
});
