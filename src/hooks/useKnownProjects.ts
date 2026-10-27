/**
 * useKnownProjects - Fetches known Claude Code project paths from the server
 * (derived from ~/.claude/projects/) and merges them with localStorage
 * workdir-history so they appear in all working-directory dropdowns.
 * The server lists them most used first.
 *
 * useRankedProjects - The phone's New session sheet: the server's ranking on
 * top, this browser's history only appended, and null until the server answers,
 * so one-tap rows never reorder under a finger.
 */
import { useState, useEffect } from 'react';

const WORKDIR_HISTORY_KEY = 'workdir-history';

function loadWorkdirHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WORKDIR_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

/** Deduplicate while preserving order (`first`, then the rest of `second`). */
function mergeDirectories(first: string[], second: string[]): string[] {
  const seen = new Set(first);
  const merged = [...first];
  for (const dir of second) {
    if (!seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged;
}

/** GET /api/known-projects; `onDone` gets the paths, or null when the request failed. Returns the cleanup. */
function fetchKnownProjects(onDone: (paths: string[] | null) => void): () => void {
  let cancelled = false;
  fetch('/api/known-projects')
    .then((r) => r.json())
    .then((data: { paths: string[] }) => {
      if (!cancelled) onDone(data.paths ?? []);
    })
    .catch(() => {
      if (!cancelled) onDone(null);
    });
  return () => { cancelled = true; };
}

export function useKnownProjects(): string[] {
  const [merged, setMerged] = useState<string[]>(() => loadWorkdirHistory());

  useEffect(() => fetchKnownProjects((paths) => {
    // Silently fall back to history-only
    if (paths) setMerged(mergeDirectories(loadWorkdirHistory(), paths));
  }), []);

  return merged;
}

export function useRankedProjects(): string[] | null {
  const [ranked, setRanked] = useState<string[] | null>(null);

  useEffect(() => fetchKnownProjects((paths) => {
    setRanked(mergeDirectories(paths ?? [], loadWorkdirHistory()));
  }), []);

  return ranked;
}
