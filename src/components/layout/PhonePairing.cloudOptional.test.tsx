// AASC-64 in the Full edition: see PhonePairing.cloudOptional.cases.tsx.
import { describe, expect, it, vi } from 'vitest';
import { IS_LITE } from '@/lib/edition';
import { describeCloudOptional } from './PhonePairing.cloudOptional.cases';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

describe('edition', () => {
  it('is Full here', () => expect(IS_LITE).toBe(false));
});

describeCloudOptional('Full');
