/**
 * PhoneKeyBar — the Terminal segment's keys (AASC-45), scrolling sideways:
 * Esc, Tab, Ctrl, ↑ ↓ ← →, 1, 2, 3, Enter. Ctrl is sticky until the next key
 * (lib/chat/terminalKeys); its pressed state is said in words, not colour alone.
 * A key never takes focus from the input line, so the keyboard stays up.
 */
import type { ReactNode } from 'react';
import { KEY_BAR, KEY_LABELS, type KeyBarKey } from '@/lib/chat/terminalKeys';
import { ArrowKey, EnterKeyIcon } from '../chat/chatIcons';
import styles from '@/styles/modules/mobile/PhoneTerminal.module.css';

const FACE: Record<KeyBarKey, ReactNode> = {
  esc: 'esc',
  tab: 'tab',
  ctrl: 'ctrl',
  up: <ArrowKey direction="up" />,
  down: <ArrowKey direction="down" />,
  left: <ArrowKey direction="left" />,
  right: <ArrowKey direction="right" />,
  '1': '1',
  '2': '2',
  '3': '3',
  enter: <EnterKeyIcon />,
};

export interface PhoneKeyBarProps {
  ctrl: boolean;
  disabled: boolean;
  onKey: (key: KeyBarKey) => void;
}

export default function PhoneKeyBar({ ctrl, disabled, onKey }: PhoneKeyBarProps) {
  return (
    <div className={styles.keyBar} role="group" aria-label="Terminal keys" data-testid="phone-key-bar">
      {KEY_BAR.map((key) => (
        <button
          key={key}
          type="button"
          className={styles.key}
          data-key={key}
          aria-label={key === 'ctrl' ? `${KEY_LABELS.ctrl}${ctrl ? ', on until the next key' : ''}` : KEY_LABELS[key]}
          aria-pressed={key === 'ctrl' ? ctrl : undefined}
          disabled={disabled}
          // Keep the input line's focus (and the keyboard): a tap's mousedown would move it here.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onKey(key)}
        >
          {FACE[key]}
        </button>
      ))}
    </div>
  );
}
