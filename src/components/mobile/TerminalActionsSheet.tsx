/**
 * TerminalActionsSheet — the terminal toolbar's actions on a phone (AASC-18): the
 * toolbar itself is not drawn there, its 27px buttons are this sheet's 48px rows,
 * opened from the button beside the compose box. Clear output asks first: it
 * empties the screen and the replay on every device.
 */
import { useCallback, useState } from 'react';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import type { TerminalWidthMode } from '@/lib/terminalGeometry';
import SheetAction, { SheetSection } from './SheetAction';
import {
  CloneIcon,
  EraseIcon,
  FollowIcon,
  ForkIcon,
  FullscreenIcon,
  PasteIcon,
  ReconnectIcon,
  RefreshIcon,
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
  onToggleFullscreen: () => void;
  onRefresh: () => void;
  onClear: () => void;
  onReconnect?: () => void;
  onFork?: () => void;
  onClone?: () => void;
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
          <SheetAction
            icon={<FullscreenIcon />}
            label={props.isFullscreen ? 'Leave full screen' : 'Full screen'}
            onClick={run(props.onToggleFullscreen)}
          />
        </SheetSection>
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
