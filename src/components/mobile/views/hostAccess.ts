/**
 * hostAccess — is this phone on the Mac itself, or a remote device (AASC-20)?
 *
 * A remote device (a paired phone, or a browser signed in with the password)
 * may not read the whole history: the session list, full-text search, the
 * project list and the cross-session prompt trace answer the host only
 * (AASC-29; a paired phone gets a 404 from its profile, a password sign-in a
 * 403 HISTORY_HOST_ONLY). The phone views never call those routes from a
 * remote device, rather than calling and failing.
 *
 * Decided by the SERVER (presence `isLocal`), never by size or user agent.
 * Unknown (presence not loaded yet) reads as remote: the safe state.
 */
import { usePresenceStore, isLocalDevice } from '@/stores/presenceStore';
import { getClientId } from '@/lib/deviceIdentity';

export function useIsHostDevice(): boolean {
  return usePresenceStore((s) => isLocalDevice(s.devices, getClientId()));
}
