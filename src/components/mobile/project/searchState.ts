/**
 * searchState — the Project tab's search, kept by the browser above the search
 * screen so Back from a hit returns to the same results (AASC-20).
 */
import type { NameHit, TextHit } from '@/lib/phoneFiles';

export type SearchMode = 'names' | 'text';

export interface SearchState {
  query: string;
  mode: SearchMode;
  /** What the results below answer (they stay until a new search lands). */
  ran: { query: string; mode: SearchMode } | null;
  busy: boolean;
  names: NameHit[];
  text: TextHit[];
  truncated: boolean;
  error: string | null;
}

export const EMPTY_SEARCH: SearchState = { query: '', mode: 'names', ran: null, busy: false, names: [], text: [], truncated: false, error: null };
