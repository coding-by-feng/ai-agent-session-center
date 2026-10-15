/**
 * SelectionReadAloud — "Read aloud" for text selected in the chat (AASC-41,
 * feature 42), beside the Ask AI bar that the same selection raises
 * (PhoneConversationAi). It stays while the reading plays, even after the tap
 * clears the selection (a read-aloud button that unmounts stops its own reading).
 * The text is captured as the finger lands, before the tap can collapse it.
 */
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { selectedTextIn, useSelectionIn } from '@/hooks/useSelectionIn';
import { useReadAloud } from '@/hooks/useReadAloud';
import ReadAloudButton from '../ReadAloudButton';
import styles from '@/styles/modules/mobile/Chat.module.css';

export default function SelectionReadAloud({ sessionId }: { sessionId: string }) {
  const speakKey = `chat-selection:${sessionId}`;
  const selected = useSelectionIn(sessionId, true);
  const { speaking } = useReadAloud(speakKey);
  const held = useRef('');
  if (!selected && !speaking) return null;
  return createPortal(
    <div
      className={styles.selectionSpeak}
      onPointerDownCapture={() => {
        held.current = selectedTextIn(sessionId) || held.current;
      }}
    >
      <ReadAloudButton speakKey={speakKey} source={() => held.current || selectedTextIn(sessionId)} label="Read aloud" />
    </div>,
    document.body,
  );
}
