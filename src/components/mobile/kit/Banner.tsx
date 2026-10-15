/**
 * Banner — a one-line state under the nav bar (AASC-38): reconnecting, a
 * session stopped, a note about what only the Mac can do. Icon + words (never
 * colour alone), an optional action; `error` is announced at once (alert), the
 * others politely (status).
 */
import type { ReactNode } from 'react';
import Button from './Button';
import { ErrorIcon, InfoIcon, OfflineIcon, SuccessIcon, WarningIcon } from './kitIcons';
import styles from '@/styles/modules/mobile/Banner.module.css';

export type BannerTone = 'info' | 'success' | 'warning' | 'error' | 'offline';

export interface BannerProps {
  tone?: BannerTone;
  title?: string;
  children?: ReactNode;
  action?: { label: string; onClick: () => void; loading?: boolean };
}

const ICONS: Record<BannerTone, ReactNode> = {
  info: <InfoIcon />,
  success: <SuccessIcon />,
  warning: <WarningIcon />,
  error: <ErrorIcon />,
  offline: <OfflineIcon />,
};

export default function Banner({ tone = 'info', title, children, action }: BannerProps) {
  return (
    <div className={styles.banner} data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      <span className={styles.icon}>{ICONS[tone]}</span>
      <div className={styles.text}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <div className={styles.body}>{children}</div>}
      </div>
      {action && (
        <Button small variant="plain" onClick={action.onClick} loading={action.loading} className={styles.action}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
