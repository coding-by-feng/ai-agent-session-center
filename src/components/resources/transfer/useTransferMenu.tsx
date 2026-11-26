/**
 * useTransferMenu — a Projects row's part of Copy / Move to another computer (Nov 27 2026): two
 * ⋯ menu items, the "Moved to …" line a Move left here, and the dialog (its own chunk, loaded on
 * first open). Desktop app (Full) only, and only for a folder on this computer.
 */
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { TransferMode } from '@/types/projectTransfer';
import type { MenuItem } from '@/components/ui/Menu';
import { IS_LITE } from '@/lib/edition';
import { movedLine } from '@/lib/projectTransferFormat';
import { refreshMoved, useMovedProject } from './movedProjects';

const TransferDialog = lazy(() => import('./TransferDialog'));

/** Electron main can send a project (the Full desktop app). */
export function canTransferProjects(): boolean {
  return !IS_LITE && typeof window.electronAPI?.remotes?.projectTransferStart === 'function';
}

export interface TransferMenu {
  menuItems: MenuItem[];
  /** "Moved to studio · Nov 27", when a Move left a marker for this folder. */
  movedLine?: string;
  /** Mount once inside the row. */
  dialog: ReactNode;
}

export function useTransferMenu(
  /** The folder on this computer (absolute), or null when the row has none. */
  path: string | null,
  onOpenProjectSync?: () => void,
): TransferMenu {
  const enabled = canTransferProjects() && !!path;
  const [mode, setMode] = useState<TransferMode | null>(null);
  const marker = useMovedProject(path, enabled);
  if (!enabled || !path) return { menuItems: [], dialog: null };
  return {
    menuItems: [
      {
        kind: 'action',
        id: 'transfer-copy',
        label: 'Copy to computer…',
        onSelect: () => setMode('copy'),
      },
      {
        kind: 'action',
        id: 'transfer-move',
        label: 'Move to computer…',
        onSelect: () => setMode('move'),
      },
    ],
    movedLine: marker ? movedLine(marker.computer, marker.at) : undefined,
    // Portaled: a row's card may be a containing block for `position: fixed` (a transform, a filter).
    dialog:
      mode &&
      createPortal(
        <Suspense fallback={null}>
          <TransferDialog
            root={path}
            mode={mode}
            open
            onClose={() => setMode(null)}
            onOpenProjectSync={onOpenProjectSync}
            onDone={() => {
              if (mode === 'move') refreshMoved();
            }}
          />
        </Suspense>,
        document.body,
      ),
  };
}
