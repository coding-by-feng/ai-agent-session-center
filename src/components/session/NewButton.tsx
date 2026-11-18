/**
 * NewButton — the "＋ New" button (Nov 17 2026): the one obvious way to start a session or make a room.
 * It sits first in the session rail's strip and first in the top bar, so one is on screen whichever of the
 * two is showing, and both open the same menu (QuickCreateMenu), as the `newSession` shortcut does.
 */
import Button from '@/components/ui/Button';
import { keyComboToString } from '@/lib/shortcutKeys';
import { useQuickCreateStore } from '@/stores/quickCreateStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { QUICK_CREATE_ANCHOR_ATTR } from '@/lib/quickCreate';

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

interface NewButtonProps {
  className?: string;
}

export default function NewButton({ className }: NewButtonProps) {
  const open = useQuickCreateStore((s) => s.open);
  const toggle = useQuickCreateStore((s) => s.toggle);
  const combo = useShortcutStore((s) => s.bindings.find((b) => b.actionId === 'newSession')?.combo ?? null);
  const hint = combo ? ` (${keyComboToString(combo)})` : '';
  return (
    <Button
      variant="primary"
      size="sm"
      icon={<PlusIcon />}
      className={className}
      onClick={toggle}
      title={`New session or room${hint}`}
      aria-label="New session or room"
      aria-expanded={open}
      aria-haspopup="dialog"
      {...{ [QUICK_CREATE_ANCHOR_ATTR]: '' }}
    >
      New
    </Button>
  );
}
