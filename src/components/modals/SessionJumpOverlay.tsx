/**
 * SessionJumpOverlay — "go to session #". Opened by the jumpToSession
 * shortcut (Alt+⌘+0 by default, rebindable). Type a session's badge number
 * (the `#` on its card in the rail): it switches as soon as the number cannot
 * grow into a longer one, or on Enter. Esc or a click outside cancels; any
 * other key cancels and passes through.
 *
 * Like SessionSwitchOverlay, focus never moves: keys are read at `document`
 * in the capture phase and the ones it handles are stopped there, so they
 * never reach the terminal underneath and the terminal keeps focus. Digits
 * are matched by physical key (`e.code`), because Option+1 types "¡" on a
 * Mac and the shortcut's own modifiers may still be held.
 *
 * Mounted unconditionally in App.tsx; `uiStore.sessionJumpOpen` owns
 * visibility. The inner box mounts fresh on every open, so the typed digits
 * start empty without an effect resetting them.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { numberedSessions } from '@/lib/sessionSort';
import { resolveJumpInput, jumpToSessionNumber } from '@/lib/sessionJump';
import styles from '@/styles/modules/SessionSwitchOverlay.module.css';

// Same maps as SessionSwitchOverlay, so the preview row looks like its rows.
const STATUS_COLORS: Record<string, string> = {
  idle: 'var(--accent-green)',
  prompting: 'var(--accent-cyan)',
  working: 'var(--accent-orange)',
  waiting: 'var(--accent-cyan)',
  approval: 'var(--accent-yellow)',
  input: 'var(--accent-purple)',
  ended: 'var(--accent-red)',
  connecting: 'var(--text-dim)',
};

const STATUS_LABELS: Record<string, string> = {
  idle: 'Idle',
  prompting: 'Prompting',
  working: 'Working',
  waiting: 'Waiting',
  approval: 'Approval',
  input: 'Input',
  ended: 'Disconnected',
  connecting: 'Connecting',
};

/** Keys that are only modifiers: pressing them neither types nor cancels. */
const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Meta', 'Control', 'CapsLock', 'Fn', 'OS', 'AltGraph']);

/** The digit a key stands for, by physical key first (see the header). */
function digitOf(e: KeyboardEvent): string | null {
  const m = /^(?:Digit|Numpad)(\d)$/.exec(e.code ?? '');
  if (m) return m[1];
  return /^\d$/.test(e.key) ? e.key : null;
}

function consume(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}

export default function SessionJumpOverlay() {
  const open = useUiStore((s) => s.sessionJumpOpen);
  if (!open) return null;
  return <JumpBox />;
}

function JumpBox() {
  const close = useUiStore((s) => s.closeSessionJump);
  const sessions = useSessionStore((s) => s.sessions);
  const numbered = useMemo(() => numberedSessions(sessions.values()), [sessions]);
  const [digits, setDigits] = useState('');
  // The key handler reads the latest digits without re-subscribing per key.
  const digitsRef = useRef('');

  useEffect(() => {
    const setTyped = (next: string) => {
      digitsRef.current = next;
      setDigits(next);
    };
    // Counted at key time, from the store: the list can change while open.
    const count = () => numberedSessions(useSessionStore.getState().sessions.values()).length;
    const jump = (n: number) => {
      if (jumpToSessionNumber(n)) close();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const digit = digitOf(e);
      if (digit !== null) {
        consume(e);
        if (digitsRef.current === '' && digit === '0') return; // no leading zero
        const next = digitsRef.current + digit;
        setTyped(next);
        const r = resolveJumpInput(next, count());
        if (r.valid && !r.canGrow && r.n !== null) jump(r.n);
        return;
      }
      if (e.key === 'Enter') {
        consume(e);
        const r = resolveJumpInput(digitsRef.current, count());
        if (r.valid && r.n !== null) jump(r.n);
        return;
      }
      if (e.key === 'Backspace') {
        consume(e);
        setTyped(digitsRef.current.slice(0, -1));
        return;
      }
      if (e.key === 'Escape') {
        consume(e);
        close();
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return;
      close(); // anything else: cancel, and let the key through
    };

    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', close);
    };
  }, [close]);

  const count = numbered.length;
  const r = resolveJumpInput(digits, count);
  const target = r.valid && r.n !== null ? numbered[r.n - 1] : undefined;
  const range = count > 0 ? `1–${count}` : 'no sessions';

  let hint: string;
  if (count === 0) hint = 'No sessions to go to.';
  else if (!digits) hint = `Type a session number (${range}).`;
  else if (!r.valid) hint = `No session #${digits} · ${range}`;
  else if (r.canGrow) hint = `⏎ opens #${digits} · or keep typing (${digits}0–${Math.min(Number(digits) * 10 + 9, count)})`;
  else hint = `Opening #${digits}…`;

  return (
    <div className={styles.overlay} onMouseDown={close}>
      <div
        className={styles.panel}
        role="dialog"
        aria-label="Go to session"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <span>GO TO SESSION</span>
          <span className={styles.hint}>{range} &middot; ⏎ open &middot; esc</span>
        </div>
        <div className={styles.jumpBody} aria-live="polite">
          <div className={styles.jumpNumber}>
            <span className={styles.jumpHash}>#</span>
            <span>{digits}</span>
            <span className={styles.jumpCaret} aria-hidden="true">▏</span>
          </div>
          {target && (
            <div className={`${styles.row} ${styles.jumpPreview}`}>
              <span
                className={styles.dot}
                style={{ background: STATUS_COLORS[target.status] ?? 'var(--text-dim)' }}
                aria-hidden="true"
              />
              <span className={styles.title}>{target.title || target.projectName || target.sessionId.slice(0, 8)}</span>
              {target.projectName && target.projectName !== target.title && (
                <span className={styles.project}>{target.projectName}</span>
              )}
              <span className={styles.status}>{STATUS_LABELS[target.status] ?? target.status}</span>
            </div>
          )}
          <div className={styles.jumpHint}>
            {digits && !r.valid && <span className={styles.jumpErrorMark} aria-hidden="true">✕ </span>}
            {hint}
          </div>
        </div>
      </div>
    </div>
  );
}
