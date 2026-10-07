/**
 * The class list behind `Button`, for an element that must look like a button
 * but is not a <button> — a router <Link> with a real href (RESOURCES'
 * Sources "Show" link). Prefer `Button`; reach for this only when the element
 * has to be an anchor. A plain module (not a component file) so React Fast
 * Refresh keeps working for Button.tsx.
 */
import styles from '@/styles/modules/Button.module.css';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'quiet';
export type ButtonSize = 'md' | 'sm';

const VARIANT_CLASS: Record<ButtonVariant, string | undefined> = {
  default: undefined,
  primary: styles.primary,
  danger: styles.danger,
  quiet: styles.quiet,
};

export function buttonClass({
  variant = 'default',
  size = 'md',
  pressed,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  pressed?: boolean;
  className?: string;
} = {}): string {
  return [
    styles.button,
    VARIANT_CLASS[variant],
    size === 'sm' ? styles.sm : undefined,
    pressed ? styles.pressed : undefined,
    className,
  ].filter(Boolean).join(' ');
}
