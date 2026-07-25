/** Follow session aliases until a live Map key is found. Returns null on a gap or cycle. */
export function followSessionAlias(
  sessionId: string,
  hasSession: (id: string) => boolean,
  getAlias: (id: string) => string | undefined,
): string | null {
  if (!sessionId) return null;
  let current = sessionId;
  const visited = new Set<string>();

  while (!visited.has(current)) {
    if (hasSession(current)) return current;
    visited.add(current);
    const next = getAlias(current);
    if (!next) return null;
    current = next;
  }
  return null;
}
