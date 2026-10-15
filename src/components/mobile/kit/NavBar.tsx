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
import type { ReactNode } from 'react';
import { ChevronLeftIcon } from './kitIcons';
import styles from '@/styles/modules/mobile/NavBar.module.css';

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
  titleId,
}: NavBarProps) {
  const showCompact = !large || collapsed;
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
            <button type="button" className={styles.titleButton} onClick={onTitlePress}>
              {titleBlock}
            </button>
          </h1>
        ) : (
          <h1 className={styles.center} id={titleId}>{titleBlock}</h1>
        )}
        <div className={styles.trailing}>{actions}</div>
      </div>
    </header>
  );
}
