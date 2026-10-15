/**
 * RawInputLine — type into the terminal itself (AASC-45), apart from the chat's
 * message box: the line is written as typed, then Enter (`submitComposed`, the
 * queue's two-write rule, so the CLI reads the Enter as a key and not as a
 * pasted newline). With Ctrl armed, the next character typed becomes its
 * control code at once (Ctrl, then C sends ^C) and never lands in the line.
 */
import type { ChangeEvent, FormEvent } from 'react';
import { typeWithCtrl } from '@/lib/chat/terminalKeys';
import { EnterKeyIcon } from '../chat/chatIcons';
import styles from '@/styles/modules/mobile/PhoneTerminal.module.css';

export interface RawInputLineProps {
  value: string;
  onChange: (value: string) => void;
  ctrl: boolean;
  /** Ctrl turned a typed character into a control code: send it, let Ctrl go. */
  onCtrlCode: (code: string) => void;
  /** Ctrl meant nothing for what was typed: let it go, keep the character. */
  onCtrlRelease: () => void;
  disabled: boolean;
  placeholder: string;
  sending: boolean;
  onSubmit: () => void;
}

export default function RawInputLine({ value, onChange, ctrl, onCtrlCode, onCtrlRelease, disabled, placeholder, sending, onSubmit }: RawInputLineProps) {
  const change = (e: ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value;
    if (ctrl && next.length === value.length + 1) {
      const caret = e.target.selectionStart ?? next.length;
      const typed = typeWithCtrl({ ctrl }, next.charAt(caret - 1));
      if (typed.consumed && typed.send) {
        onCtrlCode(typed.send);
        return;
      }
      onCtrlRelease();
    }
    onChange(next);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form className={styles.inputLine} onSubmit={submit}>
      <input
        className={styles.rawInput}
        type="text"
        value={value}
        onChange={change}
        placeholder={placeholder}
        aria-label="Type into the terminal"
        disabled={disabled}
        enterKeyHint="send"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        data-testid="raw-input"
      />
      <button
        type="submit"
        className={styles.rawSend}
        disabled={disabled || sending || value.trim() === ''}
        aria-busy={sending || undefined}
        aria-label="Type it and press Enter"
      >
        <EnterKeyIcon />
      </button>
    </form>
  );
}
