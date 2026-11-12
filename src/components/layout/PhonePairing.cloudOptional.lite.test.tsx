// AASC-64 in the Lite edition (IS_LITE mocked true, as the other *.lite.test.tsx do): see
// PhonePairing.cloudOptional.cases.tsx.
import { describe, expect, it, vi } from 'vitest';
import { IS_LITE } from '@/lib/edition';
import { describeCloudOptional } from './PhonePairing.cloudOptional.cases';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

describe('edition', () => {
  it('is Lite here', () => expect(IS_LITE).toBe(true));
});

describeCloudOptional('Lite');
