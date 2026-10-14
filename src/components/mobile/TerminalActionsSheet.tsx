/**
 * TerminalActionsSheet — the terminal toolbar's actions on a phone (AASC-18): the
 * toolbar itself is not drawn there, its 27px buttons are this sheet's 48px rows,
 * opened from the button beside the compose box. Clear output asks first: it
 * empties the screen and the replay on every device.
 *
 * AASC-20 adds the phone's own: the terminal's bookmarks (long-press a line to
 * make one) and reading the last answer aloud.
 */
import { useCallback, useState } from 'react';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import type { TerminalWidthMode } from '@/lib/terminalGeometry';
import type { TerminalBookmark } from '@/lib/terminalBookmarks';
import SheetAction, { SheetSection } from './SheetAction';
import TerminalBookmarksSection from './TerminalBookmarksSection';
import {
  CloneIcon,
  EraseIcon,
  FollowIcon,
  ForkIcon,
  FullscreenIcon,
  PasteIcon,
  ReconnectIcon,
  RefreshIcon,
  SpeakerIcon,
  StopIcon,
  ToBottomIcon,
  WrapIcon,
} from './phoneIcons';

export interface TerminalActionsSheetProps {
  open: boolean;
  onClose: () => void;
  onPaste: () => void;
  onScrollToBottom: () => void;
  autoScrollEnabled: boolean;
  onToggleAutoScroll: () => void;
  widthMode: TerminalWidthMode;
  onToggleWidthMode: () => void;
  isFullscreen: boolean;
  /** Omitted where full screen means nothing: a terminal already in a full-height sheet. */
  onToggleFullscreen?: () => void;
  onRefresh: () => void;
  onClear: () => void;
  onReconnect?: () => void;
  onFork?: () => void;
  onClone?: () => void;
  /** This terminal's bookmarks (AASC-20); omitted, no Bookmarks section. */
  bookmarks?: {
    list: readonly TerminalBookmark[];
    onJump: (bookmark: TerminalBookmark) => void;
    onRemove: (id: string) => void;
  };
  /** Read the session's last answer aloud (AASC-20); omitted, no row. Owned by
   *  the terminal, not this sheet: reading goes on after the sheet closes. */
  readAloud?: {
    speaking: boolean;
    onToggle: () => void;
  };
}

export default function TerminalActionsSheet(props: TerminalActionsSheetProps) {
  const { open, onClose } = props;
  const [confirmClear, setConfirmClear] = useState(false);
  // Stable: BottomSheet re-runs its focus effect whenever onClose changes.
  const cancelClear = useCallback(() => setConfirmClear(false), []);

  // Close first, then act: the sheet must not sit over what the action changes.
  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <>
      <BottomSheet open={open} onClose={onClose} title="Terminal">
        <SheetSection title="View">
          <SheetAction icon={<ToBottomIcon />} label="Scroll to the bottom" onClick={run(props.onScrollToBottom)} />
          <SheetAction
            icon={<FollowIcon />}
            label="Follow new output"
            pressed={props.autoScrollEnabled}
            onClick={run(props.onToggleAutoScroll)}
          />
          <SheetAction
            icon={<WrapIcon />}
            label="Wrap long lines"
            pressed={props.widthMode === 'wrap'}
            onClick={run(props.onToggleWidthMode)}
          />
          {props.onToggleFullscreen && (
            <SheetAction
              icon={<FullscreenIcon />}
              label={props.isFullscreen ? 'Leave full screen' : 'Full screen'}
              onClick={run(props.onToggleFullscreen)}
            />
          )}
          {props.readAloud && (
            <SheetAction
              icon={props.readAloud.speaking ? <StopIcon /> : <SpeakerIcon />}
              label={props.readAloud.speaking ? 'Stop reading aloud' : 'Read the last answer aloud'}
              onClick={run(props.readAloud.onToggle)}
            />
          )}
        </SheetSection>
        {props.bookmarks && (
          <TerminalBookmarksSection
            bookmarks={props.bookmarks.list}
            onJump={(b) => run(() => props.bookmarks!.onJump(b))()}
            onRemove={props.bookmarks.onRemove}
          />
        )}
        <SheetSection title="Input">
          <SheetAction icon={<PasteIcon />} label="Paste clipboard" onClick={run(props.onPaste)} />
        </SheetSection>
        <SheetSection title="Connection">
          <SheetAction icon={<RefreshIcon />} label="Refresh output" onClick={run(props.onRefresh)} />
          {props.onReconnect && (
            <SheetAction icon={<ReconnectIcon />} label="Reconnect terminal" onClick={run(props.onReconnect)} />
          )}
          {props.onFork && <SheetAction icon={<ForkIcon />} label="Fork session" onClick={run(props.onFork)} />}
          {props.onClone && <SheetAction icon={<CloneIcon />} label="Clone session" onClick={run(props.onClone)} />}
          <SheetAction
            icon={<EraseIcon />}
            label="Clear output…"
            danger
            onClick={run(() => setConfirmClear(true))}
          />
        </SheetSection>
      </BottomSheet>
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
