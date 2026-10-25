/**
 * morePages.ts — what the phone's More tab lists (AASC-47): the Library and
 * Settings pages, each a pushed screen (phoneRoutes.ts `morePath`).
 */
import type { MorePage } from './phoneRoutes';

export interface MoreEntry {
  page: MorePage;
  title: string;
  subtitle: string;
  /**
   * Listed only on the Mac itself (hostAccess). Prompt Trace on a paired phone was the
   * session's Prompts tab behind a session picker (Oct 20 2026), so it isn't listed there.
   */
  hostOnly?: boolean;
}

export const LIBRARY_PAGES: readonly MoreEntry[] = [
  { page: 'history', title: 'History', subtitle: 'Past sessions; resume one' },
  { page: 'prompts', title: 'Prompt Trace', subtitle: 'Every prompt you sent', hostOnly: true },
  { page: 'saved-prompts', title: 'Saved prompts', subtitle: 'Prompts you keep for reuse' },
  { page: 'review', title: 'Review', subtitle: 'Saved AI popups' },
  { page: 'agenda', title: 'Agenda', subtitle: 'Tasks' },
];

export const SETTINGS_PAGES: readonly MoreEntry[] = [
  { page: 'appearance', title: 'Appearance', subtitle: 'Theme, text size' },
  { page: 'notifications', title: 'Notifications', subtitle: 'Which sessions may notify you' },
  { page: 'voice', title: 'Voice', subtitle: 'Read answers aloud' },
  { page: 'translation', title: 'Translation', subtitle: 'Select-to-translate languages' },
  { page: 'advanced', title: 'Advanced', subtitle: 'Reset this phone’s settings' },
];

/**
 * More → Resources (plan 16): the desktop RESOURCES tab's Library, Cloud sync and Projects,
 * read through the Mac. It took the place of AASC-51's read-only Cloud row.
 */
export const RESOURCES_ENTRY = { title: 'Resources', subtitle: 'Library, cloud sync and projects' } as const;
