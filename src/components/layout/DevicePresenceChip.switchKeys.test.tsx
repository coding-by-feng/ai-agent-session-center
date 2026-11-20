// The devices panel's Switch part from the keyboard, in the Full edition: see DevicePresenceChip.switchKeys.cases.tsx.
import { describe, expect, it, vi } from 'vitest';
import { IS_LITE } from '@/lib/edition';
import { describeSwitchKeys } from './DevicePresenceChip.switchKeys.cases';

vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me' }));
vi.mock('@/lib/presenceClient', () => ({ releaseAllControls: vi.fn().mockResolvedValue({ ok: true, released: [] }) }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

describe('edition', () => {
  it('is Full here', () => expect(IS_LITE).toBe(false));
});

describeSwitchKeys('Full');
