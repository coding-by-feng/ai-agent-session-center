/**
 * useDriverName — who holds a session's control baton, in plain words
 * (AASC-42/43/45): "Your Mac" when it is a window on the Mac itself, else the
 * device's own label.
 */
import { usePresenceStore } from '@/stores/presenceStore';

export function useDriverName(clientId: string | undefined, label: string | undefined): string {
  const isMac = usePresenceStore((s) => !!clientId && s.devices.some((d) => d.clientId === clientId && d.isLocal));
  return isMac ? 'Your Mac' : label ?? 'Another device';
}
