import type { RemoteComputer } from '@/types/electron';

/** Which computer a launch opens by itself: the last one, or the only one. With several and no last, the person picks. */
export function pickStartComputer(computers: readonly RemoteComputer[], lastId: string | null): RemoteComputer | null {
  const active = computers.filter((c) => c.status === 'active');
  return active.find((c) => c.id === lastId) ?? (active.length === 1 ? active[0] : null);
}
