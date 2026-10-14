/**
 * PhoneTerminalInput — how a phone types into a terminal (AASC-18): the control
 * banner, the key bar (Esc Tab ↑ ↓ 1 2 3 Enter) and a compose box above the
 * on-screen keyboard. Mounted by TerminalContainer under the xterm viewer, on a
 * phone only; the viewer itself never raises the keyboard there.
 *
 * - Keys go over the live connection (`useTerminal.sendKeys`), like the desktop
 *   toolbar's: one keystroke, no focus change.
 * - Send writes the whole text, then Enter on its own (`submitComposed`, the
 *   queue's rule: Claude Code and Codex read `text + "\r"` in one write as a
 *   paste, and the Enter would land as a newline). The box clears once the text
 *   is in the terminal; on a refusal it keeps the text and says why.
 * - While another device drives the session, everything here is disabled and the
 *   banner says who drives and how to get control.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useControlBaton } from '@/hooks/useControlBaton';
import {
  PHONE_KEYS,
  PHONE_KEY_LABELS,
  PHONE_KEY_SEQUENCES,
  composedText,
  submitComposed,
  type PhoneKey,
} from '@/lib/terminalCompose';
import PhoneControlBanner from './PhoneControlBanner';
import { ArrowDownKey, ArrowUpKey, EnterKey, ToolsIcon } from './phoneIcons';
import styles from '@/styles/modules/PhoneSession.module.css';

const KEY_FACE: Record<PhoneKey, ReactNode> = {
  esc: 'Esc',
  tab: 'Tab',
  up: <ArrowUpKey />,
  down: <ArrowDownKey />,
  '1': '1',
  '2': '2',
  '3': '3',
  enter: <EnterKey />,
};

export interface PhoneTerminalInputProps {
  terminalId: string;
  /** The session whose control baton gates typing; null for a terminal with none (an ops shell). */
  sessionId: string | null;
  draft: string;
  onDraftChange: (text: string) => void;
  /** Write raw keys over the live connection (`useTerminal.sendKeys`). */
  onKey: (data: string) => void;
  /** The server's `terminal_error` for this terminal (e.g. the agent is not running). */
  socketNotice: string | null;
  onDismissSocketNotice: () => void;
  /** Open the terminal's actions sheet. */
  onOpenActions: () => void;
  /** The terminal is closed: there is nothing to type into. */
  closed?: boolean;
}

export default function PhoneTerminalInput({
  terminalId,
  sessionId,
  draft,
  onDraftChange,
  onKey,
  socketNotice,
  onDismissSocketNotice,
  onOpenActions,
  closed = false,
}: PhoneTerminalInputProps) {
  const baton = useControlBaton(sessionId);
  const locked = baton.mode === 'spectator';
  const disabled = locked || closed;
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const text = composedText(draft);
  const notice = sendError ?? socketNotice;
  // The draft as it is now, for the moment the text has landed: words typed
  // during the send's pause are a new message and must not be wiped.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  const dismissNotice = useCallback(() => {
    setSendError(null);
    onDismissSocketNotice();
  }, [onDismissSocketNotice]);

  const send = useCallback(async () => {
    if (disabled || sending || !text) return;
    setSending(true);
    dismissNotice();
    const result = await submitComposed(terminalId, text, () => {
      if (composedText(draftRef.current) === text) onDraftChange('');
    });
    setSending(false);
    if (!result.ok) setSendError(result.message);
  }, [disabled, sending, text, terminalId, onDraftChange, dismissNotice]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  // Return sends, as in a chat; Shift+Return (a hardware keyboard) is a newline.
  // Never while an IME is composing: there Return picks the candidate (Chinese, Japanese).
  const onComposeKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void send();
  };

  const placeholder = closed
    ? 'Terminal disconnected'
    : locked
      ? `${baton.holder?.label ?? 'Another device'} is driving`
      : sessionId ? 'Message the agent' : 'Type a command';

  return (
    <div className={styles.phoneInput}>
      <PhoneControlBanner baton={baton} />
      {notice && (
        <div className={styles.notice} role="alert">
          <span className={styles.noticeText}>{notice}</span>
          <button type="button" className={styles.iconBtn} onClick={dismissNotice} aria-label="Dismiss message">
            <span aria-hidden="true">×</span>
          </button>
        </div>
      )}
      <div className={styles.keyBar} role="group" aria-label="Terminal keys">
        {PHONE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`${styles.key}${key === 'enter' ? ` ${styles.keyEnter}` : ''}`}
            aria-label={PHONE_KEY_LABELS[key]}
            disabled={disabled}
            // Keep the compose box's focus (and the keyboard) where it is: a tap's
            // compatibility mousedown would otherwise move focus to the key.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onKey(PHONE_KEY_SEQUENCES[key])}
          >
            {KEY_FACE[key]}
          </button>
        ))}
      </div>
      <form className={styles.composeRow} onSubmit={onSubmit}>
        <button
          type="button"
          className={styles.toolsBtn}
          onClick={onOpenActions}
          aria-label="Terminal actions"
          aria-haspopup="dialog"
        >
          <ToolsIcon />
        </button>
        <textarea
          className={styles.compose}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onComposeKeyDown}
          placeholder={placeholder}
          aria-label="Message to send to the terminal"
          disabled={disabled}
          rows={1}
          enterKeyHint="send"
          autoCapitalize="sentences"
          autoComplete="off"
          spellCheck
        />
        <button type="submit" className={styles.sendBtn} disabled={disabled || sending || !text} aria-busy={sending || undefined}>
          {sending ? 'Sending' : 'Send'}
        </button>
      </form>
    </div>
  );
}
