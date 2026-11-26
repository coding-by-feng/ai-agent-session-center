/**
 * AttentionBell — the header's 🔔 (Nov 26 2026, Full only): how many things wait on the person (questions, approvals,
 * proceed asks, and alerts centrals raise), a short hint when a new one comes, and the list behind a click. Rules:
 * src/lib/attentionInbox.ts; what a new moment does: useAttentionInbox. Open takes the person to that session on LIVE;
 * × hides a session's wait until its next moment, or dismisses a central's alert for every device.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useAttentionStore } from '@/stores/attentionStore';
import { useAttentionInbox } from '@/hooks/useAttentionInbox';
import { HINT_SHOW_MS, type WaitItem } from '@/lib/attentionInbox';
import { AttentionHint, AttentionList } from './AttentionPanels';
import headerStyles from '@/styles/modules/Header.module.css';
import styles from '@/styles/modules/AttentionBell.module.css';

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export default function AttentionBell() {
  const { items, count } = useAttentionInbox();
  const hint = useAttentionStore((s) => s.hint);
  const [open, setOpen] = useState(false);
  const [held, setHeld] = useState(false);
  const bellRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  // A hint shows HINT_SHOW_MS from when it was last shown or merged into; hovering holds it.
  useEffect(() => {
    if (!hint || held) return;
    const left = Math.max(0, hint.shownAt + HINT_SHOW_MS - Date.now());
    const t = setTimeout(() => useAttentionStore.getState().clearHint(), left);
    return () => clearTimeout(t);
  }, [hint, held]);

  const openItem = useCallback((item: WaitItem) => {
    useSessionStore.getState().selectSession(item.sessionId);
    useUiStore.getState().restoreDetailPanel();
    navigate('/');
    setOpen(false);
    setHeld(false);
    useAttentionStore.getState().clearHint();
  }, [navigate]);

  const dismiss = useCallback((item: WaitItem) => useAttentionStore.getState().dismiss(item), []);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) bellRef.current?.focus();
  }, []);

  const toggle = useCallback(() => {
    setOpen((was) => !was);
    useAttentionStore.getState().clearHint();
  }, []);

  const label = count === 0 ? 'Nothing waiting on you' : `${count} waiting on you`;

  return (
    <>
      <button
        ref={bellRef}
        type="button"
        className={`${headerStyles.headerIconBtn} ${styles.bell} ${open ? styles.bellOpen : ''}`}
        onClick={toggle}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
      >
        <BellIcon />
        {count > 0 && (
          <span className={styles.count} data-testid="attention-count" aria-hidden="true">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && <AttentionList anchor={bellRef} items={items} onOpen={openItem} onDismiss={dismiss} onClose={close} />}
      {!open && hint && (
        <AttentionHint
          anchor={bellRef}
          hint={hint}
          onOpen={openItem}
          onClose={() => { setHeld(false); useAttentionStore.getState().clearHint(); }}
          onHold={setHeld}
        />
      )}
    </>
  );
}
