/**
 * @module codexRollout
 * Where a Codex session writes its rollout: `<CODEX_HOME>/sessions/YYYY/MM/DD/
 * rollout-<started-at>-<session id>.jsonl`. The Codex hook reports no transcript path,
 * so the session runtime (model + effort per turn) finds the file by its id.
 */
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CODEX_MAX_DAY_DIRS } from './planUsageSources.js';

/** A Codex thread id. It becomes part of a file name, so nothing else is accepted. */
const CODEX_SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read per call, like `commandIndex.ts`, so an env change needs no restart. */
export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), '.codex');
}

async function namesIn(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

const newestFirst = (names: string[], shape: RegExp): string[] =>
  names.filter((n) => shape.test(n)).sort().reverse();

/**
 * The rollout file of Codex session `sessionId`, or `null`. Day folders are walked
 * newest first (a rollout lives in the folder of the day its session BEGAN), at most
 * `maxDayDirs` of them; a symlink is never returned.
 */
export async function findCodexRollout(
  sessionId: string,
  root: string = codexHome(),
  maxDayDirs: number = CODEX_MAX_DAY_DIRS,
): Promise<string | null> {
  if (!CODEX_SESSION_ID_RE.test(sessionId)) return null;
  const suffix = `-${sessionId.toLowerCase()}.jsonl`;
  const base = join(root, 'sessions');
  let walked = 0;
  for (const year of newestFirst(await namesIn(base), /^\d{4}$/)) {
    for (const month of newestFirst(await namesIn(join(base, year)), /^\d{2}$/)) {
      for (const day of newestFirst(await namesIn(join(base, year, month)), /^\d{2}$/)) {
        if (walked++ >= maxDayDirs) return null;
        const dir = join(base, year, month, day);
        const name = (await namesIn(dir)).find((n) => n.startsWith('rollout-') && n.toLowerCase().endsWith(suffix));
        if (!name) continue;
        const path = join(dir, name);
        try {
          if ((await lstat(path)).isFile()) return path;
        } catch {
          // vanished between readdir and lstat
        }
      }
    }
  }
  return null;
}
