/**
 * projectScreens — the Project tab's own little stack (AASC-20): folders, a
 * file, the search. Back pops it; a breadcrumb rebuilds it from the folder.
 */
import { ancestorsOf, parentRel } from '@/lib/phoneProject';

export type ProjectScreen =
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; line?: number; query?: string }
  | { kind: 'search' };

/** The stack that shows `dir`, so Back walks up through its parents. */
export function dirStack(dir: string): ProjectScreen[] {
  return ancestorsOf(dir).map((path) => ({ kind: 'dir', path }));
}

/** The stack that shows a file, its folders under it. */
export function fileStack(path: string, line?: number, query?: string): ProjectScreen[] {
  return [...dirStack(parentRel(path)), { kind: 'file', path, ...(line ? { line } : {}), ...(query ? { query } : {}) }];
}

/** The folder a stack is in: its deepest folder screen. */
export function folderOf(stack: readonly ProjectScreen[]): string {
  for (let i = stack.length - 1; i >= 0; i--) {
    const screen = stack[i];
    if (screen.kind === 'dir') return screen.path;
  }
  return '/';
}
