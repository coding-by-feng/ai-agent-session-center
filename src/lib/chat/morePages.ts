/**
 * morePages.ts — what the phone's More tab lists (AASC-47): the Library and
 * Settings pages, each a pushed screen (phoneRoutes.ts `morePath`).
 */
import type { MorePage } from './phoneRoutes';

export interface MoreEntry {
  page: MorePage;
  title: string;
  subtitle: string;
}

export const LIBRARY_PAGES: readonly MoreEntry[] = [
  { page: 'history', title: 'History', subtitle: 'Past sessions; resume one' },
  { page: 'prompts', title: 'Prompt Trace', subtitle: 'Every prompt you sent' },
  { page: 'saved-prompts', title: 'Saved prompts', subtitle: 'Prompts you keep for reuse' },
  { page: 'review', title: 'Review', subtitle: 'Saved AI popups' },
  { page: 'agenda', title: 'Agenda', subtitle: 'Tasks' },
];

export const SETTINGS_PAGES: readonly MoreEntry[] = [
  { page: 'appearance', title: 'Appearance', subtitle: 'Light or dark, accent colour, text size' },
  { page: 'notifications', title: 'Notifications', subtitle: 'Which sessions may notify you' },
  { page: 'api-keys', title: 'API keys', subtitle: 'Anthropic and OpenAI, kept on this phone' },
  { page: 'translation', title: 'Translation', subtitle: 'Select-to-translate languages' },
  { page: 'advanced', title: 'Advanced', subtitle: 'Reset this phone’s settings' },
];
