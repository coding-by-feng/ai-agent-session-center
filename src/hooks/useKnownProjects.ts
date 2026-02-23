/**
 * useKnownProjects - Fetches known Claude Code project paths from the server
 * (derived from ~/.claude/projects/) and merges them with localStorage
 * workdir-history so they appear in all working-directory dropdowns.
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

/** Deduplicate while preserving order (history first, then known projects). */
function mergeDirectories(history: string[], known: string[]): string[] {
  const seen = new Set(history);
  const merged = [...history];
  for (const dir of known) {
    if (!seen.has(dir)) {
      seen.add(dir);
      merged.push(dir);
    }
  }
  return merged;
}

export function useKnownProjects(): string[] {
  const [merged, setMerged] = useState<string[]>(() => loadWorkdirHistory());

  useEffect(() => {
    let cancelled = false;

    fetch('/api/known-projects')
      .then((r) => r.json())
      .then((data: { paths: string[] }) => {
        if (cancelled) return;
        const history = loadWorkdirHistory();
        setMerged(mergeDirectories(history, data.paths ?? []));
      })
      .catch(() => {
        // Silently fall back to history-only
      });

    return () => { cancelled = true; };
  }, []);

  return merged;
}
