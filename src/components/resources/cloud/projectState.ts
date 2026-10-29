/**
 * projectState — what a Projects row says and its one button (AASC-63; one button since Oct 29
 * 2026), from a saved project's checkout state or a folder's kind. Ahead/behind are as of the
 * last fetch: the tab checks each saved project as it opens, and Pull and Push fetch first.
 */
import type { ChipTone } from '@/components/ui/Chip';
import type { LocalProject, ProjectCandidate, ProjectFolder } from '@/types/cloudProjects';
import { cloudCount } from '@/lib/cloudFormat';
import type { FolderState } from './projectList';

export type ProjectAction = 'clone' | 'pull' | 'push' | 'open' | 'save' | 'link';

export interface ProjectStatus {
  label: string;
  tone: ChipTone;
  hint?: string;
  /** The row's one button; null when nothing applies. */
  primary: ProjectAction | null;
  /** "Check for changes now" applies: a checkout on its branch. */
  check: boolean;
  /** The button waits: an agent works in the folder, and Pull and Push wait for it. */
  waits: boolean;
}
const NONE = { primary: null, check: false, waits: false };

function checkoutStatus(local: LocalProject, branch: string, checking: boolean): ProjectStatus {
  const ahead = local.ahead ?? 0,
    behind = local.behind ?? 0;
  switch (local.state) {
    case 'missing':
      return { ...NONE, primary: 'clone', label: 'Not on this device', tone: 'neutral' };
    case 'busy':
      return {
        ...NONE,
        primary: 'open',
        label: 'In use',
        tone: 'info',
        hint: 'A Git command or a merge is under way in this folder. Try again when it finishes.',
      };
    case 'detached':
      return {
        ...NONE,
        primary: 'open',
        label: 'Not on its branch',
        tone: 'warning',
        hint: `Check out ${branch} in this folder to pull or push.`,
      };
    case 'wrong-remote':
      return {
        ...NONE,
        label: 'Folder doesn’t match',
        tone: 'warning',
        hint: 'This folder’s GitHub repository or branch is not the saved one.',
      };
    case 'diverged':
      return {
        ...NONE,
        primary: 'open',
        check: true,
        label: `${cloudCount(ahead, 'commit')} to push · ${behind} behind`,
        tone: 'warning',
        hint: 'GitHub and this Mac both have new commits. Merge or rebase it yourself, then push.',
      };
    case 'dirty': {
      const push = ahead > 0 && behind === 0;
      return {
        ...NONE,
        primary: push ? 'push' : 'open',
        check: true,
        label: 'Uncommitted changes',
        tone: 'warning',
        hint:
          (ahead ? `${cloudCount(ahead, 'commit')} to push. ` : '') +
          'Commit or stash the changes to pull.',
      };
    }
    case 'ahead':
      return {
        ...NONE,
        primary: 'push',
        check: true,
        label: `${cloudCount(ahead, 'commit')} to push`,
        tone: 'info',
      };
    case 'ready':
      if (behind)
        return {
          ...NONE,
          primary: 'pull',
          check: true,
          label: `${behind} behind GitHub`,
          tone: 'info',
        };
      if (local.ahead === null)
        return {
          ...NONE,
          primary: 'open',
          check: true,
          label: checking ? 'Checking GitHub…' : 'Not checked yet',
          tone: 'neutral',
        };
      return { ...NONE, primary: 'open', check: true, label: 'Up to date', tone: 'success' };
  }
}

/**
 * A saved project's row. `checking`: the tab is reading it right now (its checkout, or GitHub).
 * Unread and not being read (the cloud is offline and the read failed): "Not read".
 */
export function projectStatus(
  local: LocalProject | undefined,
  branch: string,
  checking = false,
): ProjectStatus {
  if (!local) return { ...NONE, label: checking ? 'Checking…' : 'Not read', tone: 'neutral' };
  const status = checkoutStatus(local, branch, checking);
  // The server refuses Pull and Push while an agent works in the folder (git.ts `withLock`).
  if (local.agentActive && (status.primary === 'pull' || status.primary === 'push'))
    return {
      ...status,
      waits: true,
      hint: [
        status.hint,
        `An agent is working in this folder: ${status.primary === 'pull' ? 'Pull' : 'Push'} when it stops.`,
      ]
        .filter(Boolean)
        .join(' '),
    };
  return status;
}

/** A GitHub checkout AASC won't work in, in the row's words (git.ts `readOrigin`). */
const BLOCKED: Record<NonNullable<ProjectFolder['blocked']>, Omit<ProjectStatus, keyof typeof NONE>> = {
  settings: {
    label: 'Git settings block sync',
    tone: 'warning',
    hint: 'Its Git settings send this repository’s traffic elsewhere (url.insteadOf, a proxy or a push URL), so AASC leaves it alone.',
  },
  worktree: {
    label: 'Worktree or submodule',
    tone: 'neutral',
    hint: 'Its .git points at another checkout. Save or sync that one instead.',
  },
  detached: {
    label: 'Not on a branch',
    tone: 'neutral',
    hint: 'Check out a branch in this folder to save it.',
  },
};

/** A folder on this Mac that is not a saved project's checkout (projectList.ts). */
export function folderStatus(state: FolderState, blocked?: ProjectFolder['blocked']): ProjectStatus {
  switch (state) {
    case 'unsaved':
      return { ...NONE, primary: 'save', label: 'Not saved', tone: 'neutral' };
    case 'unlinked':
      return { ...NONE, primary: 'link', label: 'Not linked', tone: 'info' };
    case 'copy':
      return { ...NONE, primary: 'open', label: 'Another copy', tone: 'neutral' };
    case 'plain':
      return blocked
        ? { ...NONE, primary: 'open', ...BLOCKED[blocked] }
        : { ...NONE, primary: 'open', label: 'No GitHub remote', tone: 'neutral' };
  }
}

/** A project to save to the cloud: a folder here, or a pasted GitHub link. */
export interface SaveChoice {
  repository: ProjectCandidate['repository'];
  /** The folder it came from, linked on this Mac; absent for a pasted link. */
  localPath?: string;
}
