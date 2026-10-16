/**
 * TerminalMoreSheet — the Terminal segment's ⋯ (AASC-45): what the desktop
 * toolbar does, as rows. Wrap, follow output, full screen, copy the screen, the
 * terminal's bookmarks (hold a line to make one), Commands (the session's plain
 * shell), refresh, and clear, which asks first: it empties the screen and the
 * replay on every device. With AI popups on, "Ask AI about the terminal" (AASC-57).
 */
import { useCallback, useState } from 'react';
import { ConfirmSheet, ListRow, ListSection, Sheet } from '../kit';
import { CloseIcon } from '../kit/kitIcons';
import { bookmarkLabel, type TerminalBookmark } from '@/lib/terminalBookmarks';
import { BookmarkIcon, EraseIcon, FollowIcon, ReconnectIcon, RefreshIcon, SparkIcon, ToBottomIcon, WrapIcon } from '../phoneIcons';
import { CommandsIcon, CopyIcon, FullscreenIcon } from '../chat/chatIcons';
import styles from '@/styles/modules/mobile/PhoneTerminal.module.css';

export type CommandsRow =
  | { kind: 'unavailable' }
  | { kind: 'switch'; showing: 'agent' | 'shell'; onClick: () => void };

export interface TerminalMoreSheetProps {
  open: boolean;
  onClose: () => void;
  wrap: boolean;
  onToggleWrap: () => void;
  follow: boolean;
  onToggleFollow: () => void;
  onScrollToBottom: () => void;
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  onCopy: () => void;
  onRefresh: () => void;
  onClear: () => void;
  onReconnect?: () => void;
  bookmarks: { list: readonly TerminalBookmark[]; onJump: (b: TerminalBookmark) => void; onRemove: (id: string) => void };
  commands: CommandsRow | null;
  /** Ask AI about the terminal's text (AASC-57); absent while AI popups are off for the session. */
  onAskAi?: () => void;
}

const DETENTS = ['medium', 'large'] as const;

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function TerminalMoreSheet(props: TerminalMoreSheetProps) {
  const { open, onClose, bookmarks, commands } = props;
  const [confirmClear, setConfirmClear] = useState(false);
  const cancelClear = useCallback(() => setConfirmClear(false), []);
  // Close first, then act: the sheet must not sit over what the action changes.
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <>
      <Sheet open={open} onClose={onClose} title="Terminal" detents={DETENTS} testId="terminal-more-sheet">
        {props.onAskAi && (
          <ListSection header="AI">
            <ListRow
              leading={<SparkIcon />}
              title="Ask AI about the terminal"
              subtitle="Explain or translate its text, or the last answer"
              onClick={run(props.onAskAi)}
            />
          </ListSection>
        )}
        <ListSection header="View">
          <ListRow leading={<WrapIcon />} title="Wrap long lines" toggle={{ checked: props.wrap, onChange: run(props.onToggleWrap) }} />
          <ListRow leading={<FollowIcon />} title="Follow new output" toggle={{ checked: props.follow, onChange: run(props.onToggleFollow) }} />
          <ListRow leading={<ToBottomIcon />} title="Scroll to the bottom" onClick={run(props.onScrollToBottom)} />
          <ListRow leading={<FullscreenIcon />} title={props.isFullscreen ? 'Leave full screen' : 'Full screen'} onClick={run(props.onToggleFullscreen)} />
          <ListRow leading={<CopyIcon />} title="Copy the screen" onClick={run(props.onCopy)} />
        </ListSection>
        <ListSection
          header={bookmarks.list.length > 0 ? `Bookmarks · ${bookmarks.list.length}` : 'Bookmarks'}
          footer={bookmarks.list.length === 0 ? 'Hold a line in the terminal to bookmark it.' : undefined}
        >
          {bookmarks.list.length === 0 ? (
            <ListRow leading={<BookmarkIcon />} title="No bookmarks yet" />
          ) : bookmarks.list.map((b) => (
            <li key={b.id} className={styles.bookmarkRow}>
              <button
                type="button"
                className={styles.bookmarkJump}
                onClick={run(() => bookmarks.onJump(b))}
                aria-label={`Go to bookmark: ${bookmarkLabel(b.text)}`}
              >
                <span className={styles.bookmarkIcon}><BookmarkIcon /></span>
                <span className={styles.bookmarkBody}>
                  <span className={styles.bookmarkText}>{bookmarkLabel(b.text)}</span>
                  <span className={styles.bookmarkTime}>{timeOf(b.createdAt)}</span>
                </span>
              </button>
              <button
                type="button"
                className={styles.rowAction}
                onClick={() => bookmarks.onRemove(b.id)}
                aria-label={`Remove bookmark: ${bookmarkLabel(b.text, 40)}`}
              >
                <CloseIcon />
              </button>
            </li>
          ))}
        </ListSection>
        {commands && (
          <ListSection header="Commands">
            {commands.kind === 'unavailable' ? (
              <ListRow
                leading={<CommandsIcon />}
                title="Commands"
                disabledReason="A plain shell on your Mac. The phone app can’t open it: run commands on the Mac."
              />
            ) : (
              <ListRow
                leading={<CommandsIcon />}
                title={commands.showing === 'agent' ? 'Open Commands (a plain shell)' : 'Back to the agent'}
                onClick={run(commands.onClick)}
              />
            )}
          </ListSection>
        )}
        <ListSection header="Connection">
          <ListRow leading={<RefreshIcon />} title="Refresh output" onClick={run(props.onRefresh)} />
          {props.onReconnect && <ListRow leading={<ReconnectIcon />} title="Reconnect terminal" onClick={run(props.onReconnect)} />}
          <ListRow leading={<EraseIcon />} title="Clear output…" destructive onClick={run(() => setConfirmClear(true))} />
        </ListSection>
      </Sheet>
      <ConfirmSheet
        open={confirmClear}
        title="Clear the terminal output?"
        message="The screen and its scrollback are cleared on every device. The session keeps running."
        confirmLabel="Clear output"
        danger
        onConfirm={() => {
          setConfirmClear(false);
          props.onClear();
        }}
        onCancel={cancelClear}
      />
    </>
  );
}
