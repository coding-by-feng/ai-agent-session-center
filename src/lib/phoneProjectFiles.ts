/**
 * phoneProjectFiles — what the phone's Project tab remembers, per project folder
 * (AASC-56): the folder you were in, the files you have open (the desktop's file
 * tabs, as a list), the ones you read recently, and the one you were reading, so
 * leaving the tab (for Chat, the terminal, another app) and coming back lands on
 * the same file. Where in the file is `useFileReadingPosition`'s job.
 *
 * Keyed by the project folder, not the session: a /clear gives the session a new
 * id, and two sessions in one folder read the same files. Pure updates (every
 * function returns a new state) plus a Zod-checked load and a save that tolerate
 * a private window. Paths are project-relative with a leading slash.
 */
import { z } from 'zod';
import { normalizeRel } from './phoneProject';

export interface ProjectFilesState {
  /** The folder the tab shows when no file is open. */
  dir: string;
  /** Open files, in the order they were opened. */
  open: readonly string[];
  /** Files read lately, newest first (open ones included). */
  recent: readonly string[];
  /** The file being read when the tab was left, if any. */
  current: string | null;
}

export const MAX_OPEN_FILES = 8;
export const MAX_RECENT_FILES = 12;

export const EMPTY_PROJECT_FILES: ProjectFilesState = { dir: '/', open: [], recent: [], current: null };

export const projectFilesKey = (projectPath: string) => `aasc:phone-project-files:${projectPath}`;

export function openedFile(state: ProjectFilesState, path: string): ProjectFilesState {
  const open = state.open.includes(path) ? state.open : [...state.open, path].slice(-MAX_OPEN_FILES);
  const recent = [path, ...state.recent.filter((p) => p !== path)].slice(0, MAX_RECENT_FILES);
  return { ...state, open, recent, current: path };
}

export function closedFile(state: ProjectFilesState, path: string): ProjectFilesState {
  return {
    ...state,
    open: state.open.filter((p) => p !== path),
    current: state.current === path ? null : state.current,
  };
}

export function closedAllFiles(state: ProjectFilesState): ProjectFilesState {
  return { ...state, open: [], current: null };
}

/** Back from a file: it stays open (like a tab), but none is being read. */
export function leftFile(state: ProjectFilesState): ProjectFilesState {
  return state.current === null ? state : { ...state, current: null };
}

export function movedToDir(state: ProjectFilesState, dir: string): ProjectFilesState {
  return state.dir === dir ? state : { ...state, dir };
}

export function recentNotOpen(state: ProjectFilesState): string[] {
  return state.recent.filter((p) => !state.open.includes(p));
}

const pathList = (max: number) => z.array(z.string().min(1).max(4096)).transform((list) => {
  const unique = [...new Set(list.map(normalizeRel))];
  return unique.slice(0, max);
});

const storedSchema = z.object({
  dir: z.string().max(4096).transform(normalizeRel),
  open: pathList(MAX_OPEN_FILES),
  recent: pathList(MAX_RECENT_FILES),
  current: z.string().min(1).max(4096).transform(normalizeRel).nullable(),
});

export function loadProjectFiles(projectPath: string): ProjectFilesState {
  try {
    const raw = localStorage.getItem(projectFilesKey(projectPath));
    if (!raw) return EMPTY_PROJECT_FILES;
    const parsed = storedSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : EMPTY_PROJECT_FILES;
  } catch {
    return EMPTY_PROJECT_FILES;
  }
}

export function saveProjectFiles(projectPath: string, state: ProjectFilesState): void {
  try {
    localStorage.setItem(projectFilesKey(projectPath), JSON.stringify(state));
  } catch {
    /* a private window: the tab just starts at the project folder next time */
  }
}
