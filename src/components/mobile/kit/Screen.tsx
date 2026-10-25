/**
 * Screen — one phone screen (AASC-38): a NavBar, an optional banner, the content,
 * an optional footer pinned to the bottom (a composer, an action bar).
 *
 * `large` (unused since Oct 19 2026: tab roots now keep the title in the bar to save height): the 32px title scrolls with the content and the bar shows
 * the compact title once it has gone. `scroll={false}` hands the whole content
 * area to a child that scrolls itself (the terminal, an embedded list).
 *
 * The top screen of the shown stack registers its scroller with the frame
 * (screenSlot), so a tap on the active tab can scroll it back to the top.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type UIEvent } from 'react';
import NavBar from './NavBar';
import { useScreenSlot } from './screenSlot';
import styles from '@/styles/modules/mobile/Screen.module.css';

export interface ScreenProps {
  title: string;
  subtitle?: ReactNode;
  large?: boolean;
  onBack?: () => void;
  backLabel?: string;
  actions?: ReactNode;
  onTitlePress?: () => void;
  /** A hold on the title (NavBar's `onTitleLongPress`), and what it is spoken as. */
  onTitleLongPress?: () => void;
  titleLongPressHint?: string;
  /** Under the nav bar, outside the scroller (a reconnecting banner). */
  banner?: ReactNode;
  footer?: ReactNode;
  /** false: the content area does not scroll; its child does. */
  scroll?: boolean;
  /**
   * false: no nav bar and no banner — the content takes the whole screen (the Chat's
   * full-screen reading, Oct 21 2026). The screen is then named by `title` itself, and
   * the content must pad the safe areas the bar used to.
   */
  chrome?: boolean;
  children: ReactNode;
  testId?: string;
}

/** How far the large title scrolls before the bar takes over the title. */
export const LARGE_TITLE_COLLAPSE_PX = 36;

export default function Screen({
  title,
  subtitle,
  large,
  onBack,
  backLabel,
  actions,
  onTitlePress,
  onTitleLongPress,
  titleLongPressHint,
  banner,
  footer,
  scroll = true,
  chrome = true,
  children,
  testId,
}: ScreenProps) {
  const titleId = useId();
  const { isTop, registerScroller } = useScreenSlot();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (!isTop) return;
    registerScroller(scrollerRef.current);
    return () => registerScroller(null);
  }, [isTop, registerScroller]);

  const onScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    if (!large) return;
    const next = e.currentTarget.scrollTop > LARGE_TITLE_COLLAPSE_PX;
    setCollapsed((prev) => (prev === next ? prev : next));
  }, [large]);

  return (
    <section
      className={styles.screen}
      aria-labelledby={chrome ? titleId : undefined}
      aria-label={chrome ? undefined : title}
      data-testid={testId}
    >
      {chrome && (
        <NavBar
          title={title}
          subtitle={subtitle}
          large={large}
          collapsed={collapsed}
          onBack={onBack}
          backLabel={backLabel}
          actions={actions}
          onTitlePress={onTitlePress}
          onTitleLongPress={onTitleLongPress}
          titleLongPressHint={titleLongPressHint}
          titleId={large ? undefined : titleId}
        />
      )}
      {chrome && banner}
      <div
        ref={scrollerRef}
        className={scroll ? styles.scroller : styles.fixed}
        onScroll={scroll ? onScroll : undefined}
      >
        {large && <h1 id={titleId} className={styles.largeTitle}>{title}</h1>}
        {children}
      </div>
      {footer && <div className={styles.footer}>{footer}</div>}
    </section>
  );
}
