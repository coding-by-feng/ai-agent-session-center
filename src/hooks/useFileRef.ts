/**
 * useFileRef — what a folder or bare-name candidate in an agent's text really names, once the Mac
 * has said (fileRefResolve). Null until then, and null for good when it names nothing, so the
 * caller draws plain text first and a link only when one is certain.
 */
import { useEffect, useState } from 'react';
import { peekFileRef, resolveFileRef, type ResolvedRef } from '@/lib/fileRefResolve';

export function useFileRef(
  text: string | null,
  kind: 'dir' | 'bare' | null,
  projectPath: string | null | undefined,
  folders?: readonly string[],
): ResolvedRef | null {
  const foldersKey = (folders ?? []).join('\n');
  const key = text && kind && projectPath ? `${kind}\n${projectPath}\n${foldersKey}\n${text}` : '';
  const [hit, setHit] = useState<{ key: string; ref: ResolvedRef | null } | null>(null);

  useEffect(() => {
    if (!key || !text || !kind || !projectPath) return;
    const ctx = { projectPath, folders: foldersKey ? foldersKey.split('\n') : [] };
    if (peekFileRef(text, kind, ctx) !== undefined) return;
    let gone = false;
    void resolveFileRef(text, kind, ctx).then((ref) => {
      if (!gone) setHit({ key, ref });
    });
    return () => { gone = true; };
  }, [key, text, kind, projectPath, foldersKey]);

  if (!key || !text || !kind || !projectPath) return null;
  const known = peekFileRef(text, kind, { projectPath, folders: foldersKey ? foldersKey.split('\n') : [] });
  if (known !== undefined) return known;
  return hit?.key === key ? hit.ref : null;
}
