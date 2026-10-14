/**
 * PhoneSessionHeader — the open session's header on a phone (AASC-18). Wraps
 * the panel's own header (SessionSwitcher, passed as children) and adds:
 *
 *  - a "Sessions" button that opens the session drawer (SessionDrawer), which
 *    replaces the desktop's session strip (hidden on a phone);
 *  - previous / next buttons, and the same move by swiping sideways anywhere on
 *    the header: left = next, right = previous, in the drawer's list order
 *    (lib/sessionStrip.ts `stripSessionOrder`). The desktop's switcher overlay
 *    has no place on a phone.
 *
 * The wrapper is `display: contents`, so the panel's layout is the desktop's;
 * touch events still bubble through it.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import IconButton from '@/components/ui/IconButton';
import { NextSessionIcon, PrevSessionIcon, SessionListIcon } from '@/components/ui/icons';
import { useCompletionAttention, useSessionStrip } from '@/hooks/useSessionStrip';
import { useHorizontalSwipe, type SwipeDirection } from '@/hooks/useHorizontalSwipe';
import { neighbourSession, stripSessionOrder } from '@/lib/sessionStrip';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import type { Session } from '@/types';
import SessionDrawer from './SessionDrawer';
import styles from '@/styles/modules/SessionDrawer.module.css';

interface PhoneSessionHeaderProps {
  /** False (desktop): renders the children alone, untouched. */
  enabled: boolean;
  currentSession: Session;
  sessions: Map<string, Session>;
  onSwitch: (sessionId: string) => void;
  children: ReactNode;
}

export default function PhoneSessionHeader({ enabled, children, ...rest }: PhoneSessionHeaderProps) {
  if (!enabled) return <>{children}</>;
  return <PhoneHeader {...rest}>{children}</PhoneHeader>;
}

function PhoneHeader({ currentSession, sessions, onSwitch, children }: Omit<PhoneSessionHeaderProps, 'enabled'>) {
  const currentId = currentSession.sessionId;
  const strip = useSessionStrip(sessions, currentId);
  const [attentionIds, acknowledge] = useCompletionAttention(sessions, currentId);
  const order = useMemo(() => stripSessionOrder(strip.items), [strip.items]);
  const prevId = neighbourSession(order, currentId, -1);
  const nextId = neighbourSession(order, currentId, 1);
  const position = order.indexOf(currentId) + 1;
  const [drawerOpen, setDrawerOpen] = useState(false);

  const go = useCallback((id: string | null) => {
    // Re-selecting the open session would record it as its own "previous".
    if (!id || id === currentId) return;
    acknowledge(id);
    onSwitch(id);
  }, [currentId, acknowledge, onSwitch]);

  const onSwipe = useCallback((direction: SwipeDirection) => {
    go(direction === 'left' ? nextId : prevId);
  }, [go, nextId, prevId]);
  const swipe = useHorizontalSwipe<HTMLDivElement>(onSwipe);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const selectFromDrawer = useCallback((id: string) => {
    go(id);
    setDrawerOpen(false);
  }, [go]);

  const prev = prevId ? sessions.get(prevId) : undefined;
  const next = nextId ? sessions.get(nextId) : undefined;

  return (
    <div className={styles.swipeArea} data-testid="phone-session-header" {...swipe}>
      {children}
      <nav className={styles.nav} aria-label="Sessions" data-testid="phone-session-nav">
        <button
          type="button"
          className={styles.drawerButton}
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        >
          <SessionListIcon aria-hidden="true" />
          <span className={styles.drawerButtonLabel}>Sessions</span>
          {position > 0 && (
            <span className={styles.drawerButtonCount}>
              {position} of {order.length}
            </span>
          )}
          {attentionIds.size > 0 && (
            <span className={styles.drawerButtonAttention}>
              {attentionIds.size} done
            </span>
          )}
        </button>
        <IconButton
          label={prev ? `Previous session: ${sessionDisplayTitle(prev)}` : 'Previous session'}
          tooltip={false}
          disabled={!prevId}
          onClick={() => go(prevId)}
        >
          <PrevSessionIcon />
        </IconButton>
        <IconButton
          label={next ? `Next session: ${sessionDisplayTitle(next)}` : 'Next session'}
          tooltip={false}
          disabled={!nextId}
          onClick={() => go(nextId)}
        >
          <NextSessionIcon />
        </IconButton>
      </nav>
      <SessionDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        strip={strip}
        currentSessionId={currentId}
        attentionIds={attentionIds}
        onSelect={selectFromDrawer}
      />
    </div>
  );
}
