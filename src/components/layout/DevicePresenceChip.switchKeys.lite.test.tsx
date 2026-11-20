// The devices panel's Switch part from the keyboard, in the Lite edition (IS_LITE mocked true, as the other
// *.lite.test.tsx do): the switcher is in Lite, and so are its key and its search. See DevicePresenceChip.switchKeys.cases.tsx.
import { describe, expect, it, vi } from 'vitest';
import { IS_LITE } from '@/lib/edition';
import { describeSwitchKeys } from './DevicePresenceChip.switchKeys.cases';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me' }));
vi.mock('@/lib/presenceClient', () => ({ releaseAllControls: vi.fn().mockResolvedValue({ ok: true, released: [] }) }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

describe('edition', () => {
  it('is Lite here', () => expect(IS_LITE).toBe(true));
});

describeSwitchKeys('Lite');
