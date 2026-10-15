// gitExclude.ts — keep cloud install workspaces out of a checkout's `git status`.
//
// An install stages its files and keeps the original as a backup in a
// `.aasc-install-*` folder next to the destination: the moves stay renames on
// one filesystem, and Restore puts the original back. Inside a git checkout that
// folder is untracked, so Pull would call the checkout dirty. The pattern goes
// into the checkout's own `.git/info/exclude`: local to this clone, never
// committed or pushed, and nothing about the install itself changes.
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export const INSTALL_WORKSPACE_PATTERN = '.aasc-install-*/';
const EXCLUDE_MAX_BYTES = 1024 * 1024;

async function realDirectory(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Add the install-workspace pattern to `<root>/.git/info/exclude` once. Only a
 * plain checkout is touched: a `.git` file (linked worktree, submodule) or any
 * link along `.git/info/exclude` is left alone, and nothing outside it is written.
 */
export async function excludeInstallWorkspaces(root: string): Promise<void> {
  const gitDir = join(root, '.git');
  if (!(await realDirectory(gitDir))) return;
  const info = join(gitDir, 'info');
  try {
    await mkdir(info, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  if (!(await realDirectory(info))) return;
  let handle;
  try {
    handle = await open(
      join(info, 'exclude'),
      constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return; // a link: not ours to follow
    throw error;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > EXCLUDE_MAX_BYTES) return;
    // O_NOFOLLOW guards only the last name: confirm `.git` and `info` were not swapped for
    // links while opening, and that the open file is the one at that path.
    const named = await lstat(join(info, 'exclude')).catch(() => null);
    if (
      !(await realDirectory(gitDir)) ||
      !(await realDirectory(info)) ||
      !named ||
      named.dev !== st.dev ||
      named.ino !== st.ino
    )
      return;
    const text = (await handle.readFile()).toString('utf8');
    if (text.split(/\r?\n/).some((line) => line.trim() === INSTALL_WORKSPACE_PATTERN)) return;
    const lead = text && !text.endsWith('\n') ? '\n' : '';
    await handle.write(
      `${lead}# AASC cloud install backups (local only)\n${INSTALL_WORKSPACE_PATTERN}\n`,
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
}
