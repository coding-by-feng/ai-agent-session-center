// knownProjects.ts — the project folders Claude Code has worked in (~/.claude/projects/).
//
// The quick-launch list, and (AASC-28) the only folders a paired phone may
// start a session in. One function, so the list a phone is shown and the list
// it is checked against can't drift apart.

import { readdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * Decode a Claude Code project directory name back to a real filesystem path.
 * Encoding: leading `-` = `/`, `--` = `.`, other `-` = `/` (but ambiguous
 * when folder names contain hyphens like `agent-manager`).
 * We resolve ambiguity by greedily matching against the actual filesystem.
 */
export function decodeProjectDir(encoded: string): string | null {
  if (!encoded.startsWith('-')) return null;

  // Replace `--` with a placeholder for `.` before splitting
  const DOT = '\x00';
  const prepared = encoded.slice(1).replace(/--/g, DOT);
  const parts = prepared.split('-').map((p) => p.replaceAll(DOT, '.'));

  // Greedily resolve: try longest segment match against filesystem first
  function resolve(current: string, idx: number): string | null {
    if (idx >= parts.length) return current;
    for (let end = parts.length; end > idx; end--) {
      const candidate = parts.slice(idx, end).join('-');
      const fullPath = join(current, candidate);
      if (existsSync(fullPath)) {
        const result = resolve(fullPath, end);
        if (result !== null) return result;
      }
    }
    return null;
  }

  return resolve('/', 0);
}

/** Every known project folder, sorted; worktrees and `/` left out. Empty when the folder is missing. */
export function listKnownProjects(): string[] {
  try {
    const entries = readdirSync(join(homedir(), '.claude', 'projects'), { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.includes('worktrees')) continue;
      const decoded = decodeProjectDir(entry.name);
      if (decoded && decoded !== '/') paths.push(decoded);
    }
    return paths.sort();
  } catch {
    return [];
  }
}
