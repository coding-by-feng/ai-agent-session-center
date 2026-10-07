/**
 * Chip — a small, non-interactive status mark ("Idle", "live", "archived").
 * Filled-subtle and borderless so it can never be mistaken for a button.
 *
 * Pick the tone by meaning, not by colour: `success` / `warning` / `danger`
 * carry state, `info` and `accent` classify, `neutral` is the quiet default
 * (an ended session is not an error).
 */
import type { ReactNode } from 'react';
import styles from '@/styles/modules/Chip.module.css';

export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

interface ChipProps {
  tone?: ChipTone;
  children: ReactNode;
  title?: string;
  className?: string;
}

const TONE_CLASS: Record<ChipTone, string | undefined> = {
  neutral: undefined,
  info: styles.info,
  success: styles.success,
  warning: styles.warning,
  danger: styles.danger,
  accent: styles.accent,
};

export default function Chip({ tone = 'neutral', children, title, className }: ChipProps) {
  const cls = [styles.chip, TONE_CLASS[tone], className].filter(Boolean).join(' ');
  return <span className={cls} title={title}>{children}</span>;
}
