/**
 * quickCreate — what the "＋ New" menu lists (Nov 17 2026). Pure: no stores, no DOM.
 *
 * One row per project folder: the open session's project first ("This project"), then recent folders in
 * the order given (this browser's history, then the Mac's most-used list). A search keeps the rows whose
 * path contains every typed word, in any order and any case.
 */
import { shortenPath } from '@/lib/launchSession';
import { normalizeProjectPath } from '@/lib/projectGroups';

export type QuickCreateCli = 'claude' | 'codex';

/** Marks a ＋ New button: the menu opens under whichever one is on screen. */
export const QUICK_CREATE_ANCHOR_ATTR = 'data-quick-create-anchor';
/** The room manager dialog's modal id (RoomManagerModal). */
export const ROOM_MANAGER_MODAL_ID = 'manage-rooms';

export interface QuickCreateRow {
  dir: string;
  name: string;
  /** The open session's own project: listed first, under its own heading. */
  current: boolean;
}

/** Rows a 320px menu shows without a scroll that hides the footer. */
export const QUICK_CREATE_LIMIT = 8;

export function quickCreateRows(
  currentDir: string | null | undefined,
  recentDirs: readonly string[],
  query: string,
  limit = QUICK_CREATE_LIMIT,
): QuickCreateRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (dir: string) => {
    const hay = dir.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const seen = new Set<string>();
  const rows: QuickCreateRow[] = [];
  const add = (raw: string | null | undefined, current: boolean) => {
    const dir = normalizeProjectPath(raw);
    if (!dir || seen.has(dir) || !matches(dir)) return;
    seen.add(dir);
    rows.push({ dir, name: shortenPath(dir), current });
  };
  add(currentDir, true);
  for (const dir of recentDirs) {
    if (rows.length >= limit) break;
    add(dir, false);
  }
  return rows;
}

/** The agent Enter starts in `dir`: the one used there last (the form's per-folder record), else Claude. */
export function lastCliFor(dir: string, configs: Readonly<Record<string, { command?: unknown }>> | null): QuickCreateCli {
  const command = configs?.[dir]?.command;
  return typeof command === 'string' && /^(?:\S*\/)?codex(?:\s|$)/.test(command.trim()) ? 'codex' : 'claude';
}

export function otherCli(cli: QuickCreateCli): QuickCreateCli {
  return cli === 'claude' ? 'codex' : 'claude';
}
