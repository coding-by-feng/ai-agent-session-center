/** Project Sync text preview: one entry's server and local copies as a redacted unified diff. */
import { createTwoFilesPatch } from 'diff';
import { redactPatch, redactPemBlocks } from '../resourceMask.js';
import { readText, type Launcher } from './helperClient.js';
import type { SyncEntry } from '../../src/types/projectSync.js';

const DIFF_MAX = 256 * 1024;

export interface PreviewSides {
  launchLocal: Launcher;
  localRoot: string;
  /** Opens the server side; only called when the server holds the entry. */
  device: () => Promise<{ launch: Launcher; root: string }>;
}

export async function previewDiff(
  e: SyncEntry,
  sides: PreviewSides,
): Promise<{ patch: string | null; note?: string }> {
  if (e.flags.includes('credential'))
    return { patch: null, note: 'Credential files are never previewed.' };
  const left = e.device,
    right = e.local;
  if ((left && left.kind !== 'file') || (right && right.kind !== 'file'))
    return { patch: null, note: 'Only files have a text preview.' };
  if ((left?.size ?? 0) > DIFF_MAX || (right?.size ?? 0) > DIFF_MAX)
    return { patch: null, note: 'Too large to preview (over 256 KB).' };
  let mine: Buffer = Buffer.alloc(0);
  if (right)
    mine =
      (await readText(sides.launchLocal, { root: sides.localRoot, path: e.path, max: DIFF_MAX })) ??
      Buffer.alloc(0);
  let theirs: Buffer = Buffer.alloc(0);
  if (left) {
    const d = await sides.device();
    theirs =
      (await readText(d.launch, { root: d.root, path: e.path, max: DIFF_MAX, inHome: true })) ??
      Buffer.alloc(0);
  }
  if (mine.includes(0) || theirs.includes(0))
    return { patch: null, note: 'Binary file — no text preview.' };
  const patch = await new Promise<string | undefined>((resolve) =>
    createTwoFilesPatch(
      'Server',
      'This computer',
      redactPemBlocks(theirs.toString('utf8')),
      redactPemBlocks(mine.toString('utf8')),
      undefined,
      undefined,
      {
        context: 3,
        timeout: 1500,
        callback: (p) => resolve(p ? redactPatch(p).slice(0, 40000) : undefined),
      },
    ),
  );
  return patch ? { patch } : { patch: null, note: 'The preview took too long.' };
}
