/**
 * The Claude model list every picker shows — the installed CLI's own `/model` list
 * (`GET /api/claude/models`), so a new model (Fable 5.2) appears without an AASC
 * release. The static `MODEL_OPTIONS` / `MODEL_ALIAS_VERSIONS` are the fallback until
 * it arrives, or when the Mac can't read it.
 *
 * One fetch per page load, shared by the session creation modal, the AI popup, the
 * queue's Set model step and the phone's Model and effort sheet.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { ClaudeModelOption, ListClaudeModelsResponse } from '@/types/api';
import { MODEL_ALIAS_VERSIONS, MODEL_OPTIONS } from '@/lib/remoteControlName';

export interface ClaudeModelList {
  /** Tier aliases first (`fable`, `opus`, …), then pinned IDs, newest first. */
  options: readonly string[];
  /** What each alias means today: `{ fable: 'claude-fable-5-2' }`. */
  aliasVersions: Readonly<Record<string, string>>;
}

const isAlias = (model: string): boolean => !model.startsWith('claude-');

export const STATIC_CLAUDE_MODELS: ClaudeModelList = {
  options: MODEL_OPTIONS,
  aliasVersions: MODEL_ALIAS_VERSIONS,
};

/**
 * The CLI's list over the static one. Aliases in the CLI's order; pinned IDs start with
 * what each alias resolves to (the CLI lists the newest only under its alias, and it
 * must be pinnable), then the CLI's pinned rows, then static IDs it didn't name (older
 * versions stay one click away). An empty list keeps the static one.
 */
export function mergeClaudeModels(catalog: readonly ClaudeModelOption[]): ClaudeModelList {
  if (catalog.length === 0) return STATIC_CLAUDE_MODELS;
  const aliasRows = catalog.filter((m) => isAlias(m.id));
  const aliasVersions: Record<string, string> = { ...MODEL_ALIAS_VERSIONS };
  for (const m of aliasRows) {
    if (!isAlias(m.resolvedModel)) aliasVersions[m.id] = m.resolvedModel;
  }
  const ordered = [
    ...aliasRows.map((m) => m.id),
    ...MODEL_OPTIONS.filter(isAlias),
    ...aliasRows.map((m) => m.resolvedModel).filter((id) => !isAlias(id)),
    ...catalog.filter((m) => !isAlias(m.id)).map((m) => m.id),
    ...MODEL_OPTIONS.filter((m) => !isAlias(m)),
  ];
  return { options: [...new Set(ordered)], aliasVersions };
}

// ── one shared fetch ────────────────────────────────────────────────────────

let current: ClaudeModelList = STATIC_CLAUDE_MODELS;
let state: 'idle' | 'loading' | 'loaded' = 'idle';
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = (): ClaudeModelList => current;

function load(): void {
  if (state !== 'idle') return;
  state = 'loading';
  fetch('/api/claude/models', { cache: 'no-store' })
    .then(async (res) => {
      if (!res.ok) throw new Error(String(res.status));
      return res.json() as Promise<ListClaudeModelsResponse>;
    })
    .then((data) => {
      const models = Array.isArray(data?.models) ? data.models : [];
      current = mergeClaudeModels(models);
      state = 'loaded';
      listeners.forEach((l) => l());
    })
    // The static list stays; the next picker to open tries again.
    .catch(() => { state = 'idle'; });
}

/** The Claude model list, static at first and the CLI's once read. Fetches when `active`. */
export function useClaudeModels(active = true): ClaudeModelList {
  useEffect(() => {
    if (active) load();
  }, [active]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test seam: back to the static list, nothing fetched. */
export function resetClaudeModelsForTests(): void {
  current = STATIC_CLAUDE_MODELS;
  state = 'idle';
  listeners.clear();
}
