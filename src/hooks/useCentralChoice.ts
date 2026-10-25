import { useState } from 'react';
import { useUiStore } from '@/stores/uiStore';
import type { CentralChoice } from '@/lib/centralChoice';

/**
 * The Central picker's choice for one creation modal (`modalId`): Off, and Off again at every opening.
 *
 * The two forms stay mounted while closed, so state set in one opening would be waiting in the next, and a
 * central is not something to carry over: a Global picked once would be the default of every session made
 * after it, until someone noticed. A central is made on purpose, each time.
 *
 * The reset is made while rendering, from the last state seen (as `NewSessionModal` does for its folder),
 * not in an effect: an effect would show the old choice for one render and then change it.
 */
export function useCentralChoice(modalId: string): [CentralChoice, (choice: CentralChoice) => void] {
  const [choice, setChoice] = useState<CentralChoice>('off');
  const isOpen = useUiStore((s) => s.activeModal === modalId);
  const [openSeen, setOpenSeen] = useState(isOpen);
  if (isOpen !== openSeen) {
    setOpenSeen(isOpen);
    if (isOpen) setChoice('off');
  }
  return [choice, setChoice];
}
