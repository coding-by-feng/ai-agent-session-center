/**
 * NavBar — the top bar of a phone screen (AASC-38).
 *
 *   compact   ‹ Back        Title           ⋯      pushed screens; an optional
 *                         subtitle                 subtitle line under the title
 *   large     (bar empty until scrolled)    ⋯      tab roots: the 32px title sits
 *             Sessions                             in the scroll content (Screen)
 *                                                  and the bar shows the compact
 *                                                  title once it has scrolled away
 *
 * Covers the status bar / notch inset. Exactly one heading names the screen: the
 * compact title in compact mode; the large title (in Screen) in large mode, the
 * bar's copy then being aria-hidden.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { ChevronLeftIcon } from './kitIcons';
import { LONG_PRESS_MS } from './menuPosition';
import styles from '@/styles/modules/mobile/NavBar.module.css';

/** A finger that moves this far is scrolling or swiping back, not holding (as in ContextMenu). */
const MOVE_CANCEL_PX = 10;

export interface NavBarProps {
  title: string;
  subtitle?: ReactNode;
  /** Large-title mode (a tab root). */
  large?: boolean;
  /** Large mode, scrolled past the large title: show the compact title. */
  collapsed?: boolean;
  onBack?: () => void;
  /** What the back button says aloud ("Back to Sessions"); the chevron is all that shows. */
  backLabel?: string;
  /** Buttons on the right (44px each). */
  actions?: ReactNode;
  /** Makes the title a button (a session's title will open its info). */
  onTitlePress?: () => void;
  /** A hold on that title button (a session's: its recent prompts, Oct 23 2026). Shift+F10 or the
   *  context-menu key does the same from a keyboard; the click that ends a hold is swallowed. */
  onTitleLongPress?: () => void;
  /** Spoken with the title when it has a long press ("Hold for recent prompts"). */
  titleLongPressHint?: string;
  titleId?: string;
}

export default function NavBar({
  title,
  subtitle,
  large,
  collapsed,
  onBack,
  backLabel = 'Back',
  actions,
  onTitlePress,
  onTitleLongPress,
  titleLongPressHint,
  titleId,
}: NavBarProps) {
  const showCompact = !large || collapsed;
  const hintId = useId();
  const hold = useTitleHold(onTitleLongPress);
  const titleBlock = (
    <>
      <span className={styles.title}>{title}</span>
      {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
    </>
  );

  return (
    <header className={`${styles.navBar}${large && !collapsed ? ` ${styles.flat}` : ''}`}>
      <div className={styles.bar}>
        <div className={styles.leading}>
          {onBack && (
            <button type="button" className={styles.back} onClick={onBack} aria-label={backLabel}>
              <ChevronLeftIcon />
            </button>
          )}
        </div>
        {large ? (
          <div className={`${styles.center} ${showCompact ? styles.shown : styles.concealed}`} aria-hidden="true">
            {titleBlock}
          </div>
        ) : onTitlePress ? (
          <h1 className={styles.center} id={titleId}>
            <button
              type="button"
              className={styles.titleButton}
              onClick={onTitlePress}
              aria-describedby={onTitleLongPress && titleLongPressHint ? hintId : undefined}
              {...hold}
            >
              {titleBlock}
            </button>
          </h1>
        ) : (
          <h1 className={styles.center} id={titleId}>{titleBlock}</h1>
        )}
        {/* Outside the heading: it describes the button, it is not part of the screen's name. */}
        {onTitlePress && onTitleLongPress && titleLongPressHint && (
          <span id={hintId} className={styles.srOnly}>{titleLongPressHint}</span>
        )}
        <div className={styles.trailing}>{actions}</div>
      </div>
    </header>
  );
}

/**
 * The title button's hold (touch and pen only: a mouse has its right button). The
 * kit's ContextMenu does the same: a finger held still for LONG_PRESS_MS fires it,
 * moving past MOVE_CANCEL_PX cancels it, and the click its release sends is
 * swallowed, so a hold never also does the tap's action. No handlers without one.
 */
function useTitleHold(onLongPress: (() => void) | undefined) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const swallowClick = useRef(false);
  const cancel = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => () => {
    if (press.current) clearTimeout(press.current.timer);
  }, []);
  if (!onLongPress) return {};
  return {
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      cancel();
      swallowClick.current = false;
      if (e.pointerType === 'mouse') return;
      press.current = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press.current = null;
          swallowClick.current = true;
          onLongPress();
        }, LONG_PRESS_MS),
      };
    },
    onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
      const p = press.current;
      if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    // Android fires contextmenu on a hold too: the hold already answered it.
    onContextMenu: (e: MouseEvent<HTMLButtonElement>) => {
      e.preventDefault();
      cancel();
      if (swallowClick.current) return;
      onLongPress();
    },
    onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => {
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        onLongPress();
      }
    },
    onClickCapture: (e: MouseEvent<HTMLButtonElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
