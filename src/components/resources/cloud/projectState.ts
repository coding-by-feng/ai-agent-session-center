/**
 * projectState — what a saved project's row says and offers on this device (AASC-63), from its
 * checkout state. Ahead/behind are as of the last fetch: Check, Pull and Push each fetch first.
 */
import type { ChipTone } from '@/components/ui/Chip';
import type { LocalProject } from '@/types/cloudProjects';
import { cloudCount } from '@/lib/cloudFormat';

export interface ProjectStatus {
  label: string;
  tone: ChipTone;
  hint?: string;
  clone: boolean;
  pull: boolean;
  push: boolean;
  check: boolean;
}
const NONE = { clone: false, pull: false, push: false, check: false };

export function projectStatus(local: LocalProject | undefined, branch: string): ProjectStatus {
  if (!local) return { ...NONE, label: 'Checking…', tone: 'neutral' };
  const ahead = local.ahead ?? 0,
    behind = local.behind ?? 0;
  switch (local.state) {
    case 'missing':
      return { ...NONE, clone: true, label: 'Not on this device', tone: 'neutral' };
    case 'busy':
      return {
        ...NONE,
        label: 'In use',
        tone: 'info',
        hint: 'An agent or a Git command is working in this folder. Try again when it stops.',
      };
    case 'detached':
      return {
        ...NONE,
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
        check: true,
        label: `${cloudCount(ahead, 'commit')} to push · ${behind} behind`,
        tone: 'warning',
        hint: 'GitHub and this Mac both have new commits. Merge or rebase it yourself, then push.',
      };
    case 'dirty':
      return {
        ...NONE,
        check: true,
        push: ahead > 0 && behind === 0,
        label: 'Uncommitted changes',
        tone: 'warning',
        hint:
          (ahead ? `${cloudCount(ahead, 'commit')} to push. ` : '') +
          'Commit or stash the changes to pull.',
      };
    case 'ahead':
      return {
        ...NONE,
        check: true,
        push: true,
        label: `${cloudCount(ahead, 'commit')} to push`,
        tone: 'info',
      };
    case 'ready':
      if (behind)
        return { ...NONE, check: true, pull: true, label: `${behind} behind GitHub`, tone: 'info' };
      if (local.ahead === null)
        return {
          ...NONE,
          check: true,
          label: 'Not checked yet',
          tone: 'neutral',
          hint: 'Check asks GitHub what is new.',
        };
      return { ...NONE, check: true, label: 'Up to date', tone: 'success' };
  }
}
