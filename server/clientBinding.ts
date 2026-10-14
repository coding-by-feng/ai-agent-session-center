// clientBinding.ts — a remote device id belongs to the sign-in that first used it (AASC-27).
//
// Device ids are self-reported (the browser picks one) and every device can see
// the others' ids in presence, so a remote device could present another
// device's id to pass the control-baton check. The first remote sign-in to use
// an id owns it; a different sign-in may take it over only after the owner's
// sign-in has fully expired (a fresh login on the same browser after logging
// out or timing out). Local devices are trusted and never bound.

const bindings = new Map<string, string>(); // clientId -> sign-in lineage

export function bindRemoteClientId(
  clientId: string,
  lineage: string | null,
  isLineageAlive: (lineage: string) => boolean,
): boolean {
  if (!clientId || !lineage) return false;
  const owner = bindings.get(clientId);
  if (owner === undefined || owner === lineage || !isLineageAlive(owner)) {
    bindings.set(clientId, lineage);
    return true;
  }
  return false;
}

/** Test seam. */
export function _resetClientBindingsForTests(): void {
  bindings.clear();
}
