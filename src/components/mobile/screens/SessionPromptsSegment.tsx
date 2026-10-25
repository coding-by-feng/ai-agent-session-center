/**
 * SessionPromptsSegment — a session's Prompts tab on the phone (Oct 19 2026): every
 * prompt the Mac recorded for it, newest first by day, with search; a prompt opens
 * in full with Copy, Save and Use again. The More → Prompt Trace view locked to
 * this session, loaded on first use so none of it is in the frame's chunk.
 */
import { lazy, Suspense } from 'react';
import { EmptyState } from '../kit';
import type { PeekPrompt } from '@/lib/promptPeek';
import styles from '@/styles/modules/mobile/SessionInfo.module.css';

const PhonePrompts = lazy(() => import('../views/PhonePrompts'));

export interface SessionPromptsSegmentProps {
  sessionId: string;
  /** Put a prompt back in the composer, on Chat. */
  onUseAgain: (text: string) => void;
  /** A prompt tapped in the title's recent list (Oct 23 2026): opened once its row loads. */
  openAt?: PeekPrompt | null;
  /** That prompt was shown and closed: the request is over. */
  onOpenAtDone?: () => void;
}

export default function SessionPromptsSegment({ sessionId, onUseAgain, openAt, onOpenAtDone }: SessionPromptsSegmentProps) {
  return (
    <div className={styles.fill}>
      <Suspense fallback={<EmptyState live title="Loading…" />}>
        <PhonePrompts sessionId={sessionId} onUseAgain={onUseAgain} openAt={openAt} onOpenAtDone={onOpenAtDone} />
      </Suspense>
    </div>
  );
}
