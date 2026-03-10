// fileIndexCache.ts — Cached file index for fast fuzzy search
import { readdir } from 'fs/promises';
import { join } from 'path';
import log from './logger.js';

/** Directories to skip when indexing. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '__pycache__', '.venv',
  'venv', 'dist', 'build', '.cache', '.turbo', 'coverage', '.svelte-kit',
]);

interface FileEntry {
  /** Relative path from project root (e.g. "src/utils/format.ts") */
  path: string;
  /** Filename only (e.g. "format.ts") */
  name: string;
  /** Lowercase path for matching */
  pathLower: string;
  /** Lowercase name for matching */
  nameLower: string;
  type: 'file' | 'dir';
}

interface CachedIndex {
  entries: FileEntry[];
  builtAt: number;
}

const cache = new Map<string, CachedIndex>();
const building = new Set<string>();

const CACHE_TTL_MS = 30_000; // 30 seconds
const MAX_ENTRIES = 50_000;
const MAX_DEPTH = 10;

/** Build the file index for a project root (async, non-blocking). */
async function buildIndex(root: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];

  async function walk(dir: string, relPrefix: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;
    try {
      const dirEntries = await readdir(dir, { withFileTypes: true });
      // Batch child directory walks to yield back to event loop periodically
      const childDirs: Array<{ path: string; rel: string }> = [];
      for (const entry of dirEntries) {
        if (entries.length >= MAX_ENTRIES) break;
        if (entry.isDirectory() && (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.'))) continue;
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        entries.push({
          path: relPath,
          name: entry.name,
          pathLower: relPath.toLowerCase(),
          nameLower: entry.name.toLowerCase(),
          type: entry.isDirectory() ? 'dir' : 'file',
        });
        if (entry.isDirectory()) {
          childDirs.push({ path: join(dir, entry.name), rel: relPath });
        }
      }
      for (const child of childDirs) {
        await walk(child.path, child.rel, depth + 1);
      }
    } catch { /* permission errors, etc. */ }
  }

  await walk(root, '', 0);
  return entries;
}

/**
 * Start building the index in the background.
 * Does not block the caller. Does not duplicate concurrent builds.
 */
function ensureIndex(root: string): void {
  const cached = cache.get(root);
  if (cached && Date.now() - cached.builtAt < CACHE_TTL_MS) return;
  if (building.has(root)) return;

  building.add(root);
  buildIndex(root)
    .then(entries => {
      cache.set(root, { entries, builtAt: Date.now() });
      log.debug('file-index', `Built index for ${root}: ${entries.length} entries`);
    })
    .catch(err => {
      log.error('file-index', `Failed to build index for ${root}: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => {
      building.delete(root);
    });
}

/** Score a fuzzy match. Higher = better. Returns -1 if no match. */
function fuzzyScore(query: string, nameLower: string, pathLower: string): number {
  // Exact filename match
  if (nameLower === query) return 1000;

  // Filename starts with query
  if (nameLower.startsWith(query)) return 800 + (query.length / nameLower.length) * 100;

  // Filename contains query as substring
  const nameIdx = nameLower.indexOf(query);
  if (nameIdx >= 0) return 600 + (query.length / nameLower.length) * 100;

  // Path contains query as substring
  const pathIdx = pathLower.indexOf(query);
  if (pathIdx >= 0) return 400 + (query.length / pathLower.length) * 50;

  // Fuzzy match on filename: all query chars appear in order
  let qi = 0;
  let consecutiveBonus = 0;
  let prevMatchIdx = -2;
  for (let i = 0; i < nameLower.length && qi < query.length; i++) {
    if (nameLower[i] === query[qi]) {
      if (i === prevMatchIdx + 1) consecutiveBonus += 10;
      prevMatchIdx = i;
      qi++;
    }
  }
  if (qi === query.length) return 200 + consecutiveBonus + (query.length / nameLower.length) * 50;

  // Fuzzy match on full path
  qi = 0;
  consecutiveBonus = 0;
  prevMatchIdx = -2;
  for (let i = 0; i < pathLower.length && qi < query.length; i++) {
    if (pathLower[i] === query[qi]) {
      if (i === prevMatchIdx + 1) consecutiveBonus += 5;
      prevMatchIdx = i;
      qi++;
    }
  }
  if (qi === query.length) return 50 + consecutiveBonus + (query.length / pathLower.length) * 20;

  return -1; // No match
}

export interface SearchResult {
  path: string;
  name: string;
  type: 'file' | 'dir';
  score: number;
}

/**
 * Search the file index with fuzzy matching and scoring.
 * - If cache is warm: instant results from memory.
 * - If cache is cold: returns { results: [], indexing: true } and builds index in background.
 *   The frontend retries shortly to pick up the ready cache.
 */
export function searchFiles(
  root: string,
  query: string,
  maxResults = 50,
): { results: SearchResult[]; indexing: boolean } {
  // Always ensure index is fresh (no-op if already cached/building)
  ensureIndex(root);

  const cached = cache.get(root);
  if (!cached) {
    // Index not ready yet — return empty with indexing flag
    return { results: [], indexing: true };
  }

  const queryLower = query.toLowerCase();
  const scored: SearchResult[] = [];

  for (const entry of cached.entries) {
    const score = fuzzyScore(queryLower, entry.nameLower, entry.pathLower);
    if (score >= 0) {
      scored.push({ path: '/' + entry.path, name: entry.name, type: entry.type, score });
    }
  }

  // Sort by score descending, then alphabetically
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { results: scored.slice(0, maxResults), indexing: false };
}

/** Invalidate cache for a project root. */
export function invalidateCache(root: string): void {
  cache.delete(root);
}

/** Preload the index for a project root (fire and forget). */
export function preloadIndex(root: string): void {
  ensureIndex(root);
}
