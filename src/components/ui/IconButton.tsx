/**
 * IconButton — a button whose glyph is the whole face. `label` is required: it
 * is the accessible name and the hover tooltip, because an icon has no words.
 *
 *   <IconButton label="Delete task" tone="danger" onClick={del}><TrashIcon /></IconButton>
 *   <IconButton label="Favorite" tone="warning" pressed={fav} onClick={toggle}>★</IconButton>
 *
 * Use it for a verb repeated down a list (copy, delete, resume); use `Button`
 * for a one-off action that deserves a word. Sizing keeps the hit target and
 * the painted chip apart (see Button.module.css): 28px everywhere you can see,
 * 44px under a finger.
 */
import type { ComponentPropsWithRef, ReactNode } from 'react';
import Tooltip, { type TooltipPlacement } from '@/components/ui/Tooltip';
import styles from '@/styles/modules/Button.module.css';

export type IconButtonTone = 'default' | 'danger' | 'warning';

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'aria-label' | 'aria-pressed'> {
  /** Names the action — the tooltip, and the aria-label unless `ariaLabel` is set. */
  label: string;
  /**
   * A fuller accessible name when the same verb repeats down a list: the
   * tooltip says "Delete task", the screen reader hears `Delete "Buy milk"`,
   * so a list of buttons is not N identical entries. Should start with the
   * label's words.
   */
  ariaLabel?: string;
  /** Optional one-sentence tooltip line under the label. */
  description?: string;
  /** Optional shortcut hint shown in the tooltip. */
  shortcut?: string;
  tone?: IconButtonTone;
  size?: 'md' | 'sm';
  /** Toggle state; undefined = a plain action. */
  pressed?: boolean;
  /** Set false where a tooltip would be noise; the aria-label stays. */
  tooltip?: boolean;
  tooltipPlacement?: TooltipPlacement;
  children: ReactNode;
}

const TONE_CLASS: Record<IconButtonTone, string | undefined> = {
  default: undefined,
  danger: styles.iconDanger,
  warning: styles.iconWarning,
};

export default function IconButton({
  label,
  ariaLabel,
  description,
  shortcut,
  tone = 'default',
  size = 'md',
  pressed,
  tooltip = true,
  tooltipPlacement,
  className,
  type = 'button',
  children,
  ...rest
}: IconButtonProps) {
  const cls = [
    styles.iconButton,
    size === 'sm' ? styles.iconSm : undefined,
    TONE_CLASS[tone],
    className,
  ].filter(Boolean).join(' ');

  return (
    <Tooltip
      label={label}
      description={description}
      shortcut={shortcut}
      placement={tooltipPlacement}
      disabled={!tooltip}
    >
      <button {...rest} type={type} className={cls} aria-label={ariaLabel ?? label} aria-pressed={pressed}>
        {children}
      </button>
    </Tooltip>
  );
}
