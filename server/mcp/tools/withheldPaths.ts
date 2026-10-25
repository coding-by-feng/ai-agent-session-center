// tools/withheldPaths.ts — the part of home a central may never name: ~/Library, and anything below a hidden segment
// (~/.ssh, ~/.config). image_upload and note_attach_media (imageUpload.ts) refuse a file there, and the P6 folder rule
// (cloudWrite.ts `cloudFolder`) a folder there. By the path's words only, so it reads nothing from disk: the P6 cloud
// modules import it, and they import no file system (test/mcp/cloudToolSources.test.ts).

import { relative, sep } from 'node:path';

/** Is this path, already under `home`, in ~/Library or below a hidden segment? Library is matched in any case: the Mac's disk ignores it. */
export function withheld(path: string, home: string): boolean {
  const segments = relative(home, path).split(sep);
  return segments[0].toLowerCase() === 'library' || segments.some((segment) => segment.startsWith('.'));
}
