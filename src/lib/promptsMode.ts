/**
 * @module promptsMode
 * Which PROMPTS view this computer last chose (Nov 20 2026): the List, or one Day at a time.
 * A per-computer preference, like the theme, so it lives in localStorage; a blocked storage
 * (private window, quota) falls back to List and never throws.
 */
export type PromptsMode = 'list' | 'days';

export const PROMPTS_MODE_KEY = 'aasc-prompts-view';

export function readPromptsMode(): PromptsMode {
  try {
    return localStorage.getItem(PROMPTS_MODE_KEY) === 'days' ? 'days' : 'list';
  } catch {
    return 'list';
  }
}

export function savePromptsMode(mode: PromptsMode): void {
  try {
    localStorage.setItem(PROMPTS_MODE_KEY, mode);
  } catch {
    // Not remembered; the choice still holds until the tab is left.
  }
}
