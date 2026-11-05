/**
 * useProjectOrder — the order this phone lists its projects in on Sessions, By
 * project (Nov 4 2026). Per device, in localStorage: the Mac keeps no project order.
 */
import { useCallback, useState } from 'react';
import { PROJECT_ORDER_KEY, parseProjectOrder } from '@/lib/chat/projectsListModel';

function readOrder(): readonly string[] {
  try {
    return parseProjectOrder(localStorage.getItem(PROJECT_ORDER_KEY));
  } catch {
    return [];
  }
}

export function useProjectOrder(): {
  order: readonly string[];
  save: (next: readonly string[]) => void;
} {
  const [order, setOrder] = useState<readonly string[]>(readOrder);
  const save = useCallback((next: readonly string[]) => {
    setOrder(next);
    try {
      localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(next));
    } catch {
      /* the order lasts until reload */
    }
  }, []);
  return { order, save };
}
