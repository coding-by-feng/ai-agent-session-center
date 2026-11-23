/**
 * The chat's quieter rows (AASC-41):
 *   DividerRow  a session event as a thin centred line: compacted, stopped, model,
 *               resumed, background task, added context (opens when it has text)
 *   NoticeRow   a notice from the CLI (an API error, a warning)
 *   CommandRow  a slash command you ran, with what it printed: one short line (/model's "Set model to `Opus 5.5`
 *               …", Nov 23 2026) reads as a sentence with its `names` in code; longer output keeps the
 *               monospace box
 */
import { useId } from 'react';
import type { CommandItem, DividerItem, NoticeItem } from '@/lib/chat/buildChatItems';
import OutputBlock from './OutputBlock';
import { WarningIcon } from '../../kit/kitIcons';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface DividerRowProps {
  item: DividerItem;
  expanded: boolean;
  onToggle: (key: string) => void;
}

export function DividerRow({ item, expanded, onToggle }: DividerRowProps) {
  const textId = useId();
  if (!item.text) {
    return (
      <div className={styles.divider} role="separator" aria-label={item.label}>
        <span className={styles.dividerLabel}>{item.label}</span>
      </div>
    );
  }
  return (
    <div>
      <div className={styles.divider}>
        <button
          type="button"
          className={styles.dividerBtn}
          aria-expanded={expanded}
          aria-controls={expanded ? textId : undefined}
          onClick={() => onToggle(item.key)}
        >
          {item.label}
        </button>
      </div>
      {expanded && (
        <div id={textId} className={styles.detail}>
          <OutputBlock text={item.text} prose label={item.label} />
        </div>
      )}
    </div>
  );
}

export function NoticeRow({ item }: { item: NoticeItem }) {
  return (
    <div className={styles.notice} role="note">
      <span className={styles.noticeIcon}><WarningIcon size={18} /></span>
      <div className={styles.noticeBody}>
        <span className={styles.noticeLabel}>{item.label}</span>
        {item.text && <OutputBlock text={item.text} prose lines={6} />}
      </div>
    </div>
  );
}

/** Output this short and on one line is a sentence ("Set model to `Opus 5.5` and saved as your default …"). */
const ONE_LINE_MAX = 240;

/** `text` with each `span` in backticks as code; an unpaired backtick stays as it is. */
function withInlineCode(text: string) {
  return text.split(/(`[^`\n]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
  );
}

export function CommandRow({ item }: { item: CommandItem }) {
  const name = item.name.startsWith('/') ? item.name : `/${item.name}`;
  const output = item.output?.trim() ?? '';
  const oneLine = output !== '' && !output.includes('\n') && output.length <= ONE_LINE_MAX;
  return (
    <div className={styles.command}>
      <span className={styles.commandPill}>{[name, item.args].filter(Boolean).join(' ')}</span>
      {oneLine && (
        <p className={styles.commandResult} role="note" aria-label={`What ${name} printed`}>
          {withInlineCode(output)}
        </p>
      )}
      {output !== '' && !oneLine && (
        <div className={styles.commandOutput}>
          <OutputBlock text={item.output ?? ''} wrap lines={4} label={`What ${name} printed`} />
        </div>
      )}
    </div>
  );
}
