/**
 * CallMemoryBanner — "Your call left 2 things to review" under the phone's Sessions bar (Nov 22 2026).
 * After a call the Mac suggests what to remember (server/voice/callMemoryExtract.ts, up to a minute after hang-up);
 * Review opens the same list as Settings → Voice calls on the Mac. Nothing is used until it is kept there.
 * Mounted only in the phone app (calls are made from it).
 */
import { useEffect, useState } from 'react';
import { Banner, Sheet } from '../kit';
import CallMemoryReview from '@/components/voice/CallMemoryReview';
import { CALL_MEMORY_RECHECK_MS, fetchCallMemory } from '@/lib/callMemoryClient';

export default function CallMemoryBanner() {
  const [pending, setPending] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetchCallMemory()
        .then((list) => { if (!cancelled && list) setPending(list.items.filter((i) => i.status === 'proposed').length); })
        .catch(() => undefined);
    };
    check();
    const timers = CALL_MEMORY_RECHECK_MS.map((ms) => setTimeout(check, ms));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, []);

  return (
    <>
      {pending > 0 && (
        <Banner tone="info" title={`Your call left ${pending} ${pending === 1 ? 'thing' : 'things'} to review`} action={{ label: 'Review', onClick: () => setOpen(true) }}>
          AASC uses only what you keep.
        </Banner>
      )}
      <Sheet open={open} onClose={() => setOpen(false)} title="Call memory">
        {open && <CallMemoryReview onPendingChange={setPending} />}
      </Sheet>
    </>
  );
}
