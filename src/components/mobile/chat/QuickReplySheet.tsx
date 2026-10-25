/**
 * QuickReplySheet — edit what the composer's P button sends (Oct 21 2026). Opened by
 * holding the P. Kept on this phone (lib/chat/quickReply.ts); "proceed" by default.
 */
import { useState } from 'react';
import { Button, Sheet } from '../kit';
import { DEFAULT_QUICK_REPLY, QUICK_REPLY_MAX, setQuickReply } from '@/lib/chat/quickReply';
import styles from '@/styles/modules/mobile/ComposerSheets.module.css';

export interface QuickReplySheetProps {
  open: boolean;
  onClose: () => void;
  /** The text saved now (the field starts from it). */
  current: string;
}

const FIT = ['fit'] as const;

export default function QuickReplySheet({ open, onClose, current }: QuickReplySheetProps) {
  const [text, setText] = useState(current);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setText(current);
  }
  const blank = text.trim() === '';

  const save = () => {
    if (blank) return;
    setQuickReply(text);
    onClose();
  };
  const reset = () => {
    setQuickReply(DEFAULT_QUICK_REPLY);
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Quick reply"
      detents={FIT}
      testId="quick-reply-sheet"
      footer={(
        <div className={styles.quickActions}>
          <Button variant="primary" block onClick={save} disabledReason={blank ? 'Type what P should send' : undefined}>Save</Button>
          <Button variant="plain" block onClick={reset}>{`Reset to “${DEFAULT_QUICK_REPLY}”`}</Button>
        </div>
      )}
    >
      <p className={styles.note}>P sends this in one tap, the way Send would. Kept on this phone.</p>
      <textarea
        className={styles.quickField}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={QUICK_REPLY_MAX}
        rows={3}
        aria-label="Quick reply text"
        autoCapitalize="sentences"
        spellCheck
      />
    </Sheet>
  );
}
