/**
 * resourceSafety — coverage for what the RESOURCES scan deliberately does NOT
 * read. Credentials are counted by name, transcripts, history and databases
 * are sized, and a project folder the scan may not open is reported as
 * inaccessible — each as a coverage row, because "not scanned" is an answer,
 * never an absence. Nothing in this file opens a file.
 */
import { join } from 'path';
import type { CoverageCategory, CoverageEntry, CoverageStatus, ResourceAgent } from '../src/types/resources.js';
import { isCredentialPath, listDir, listFlatFiles, lstatSize, sizeTree } from './fsSafe.js';
import type { Limiter } from './fsSafe.js';
import type { ProjectRecord } from './resourceRoots.js';

export const PHASE_D_NOTE = 'Phase D — size only';

/** The slice of the adapter context these rows need (an `AdapterContext` satisfies it). */
export interface CoverageContext {
  display: (absPath: string) => string;
  limit: Limiter;
  limits: { sizeMaxEntries: number };
}

function row(
  ctx: CoverageContext,
  rootAbs: string,
  agent: ResourceAgent,
  category: CoverageCategory,
  status: CoverageStatus,
  extra: { count?: number; bytes?: number; note?: string } = {},
): CoverageEntry {
  return { root: ctx.display(rootAbs), agent, category, status, ...extra };
}

export async function sizedFile(ctx: CoverageContext, root: string, agent: ResourceAgent, category: CoverageCategory, file: string): Promise<CoverageEntry> {
  const bytes = await lstatSize(join(root, file), ctx.limit);
  return bytes === null
    ? row(ctx, root, agent, category, 'not-found', { note: PHASE_D_NOTE })
    : row(ctx, root, agent, category, 'not-scanned', { count: 1, bytes, note: PHASE_D_NOTE });
}

/** `secrets/**` plus top-level `*.pem`, `*.key`, `.credentials*` — counted by name, never opened. */
export async function claudeCredentials(ctx: CoverageContext, root: string): Promise<CoverageEntry> {
  const listing = await listDir(root, ctx.limit);
  const named = listing.status === 'ok' ? listing.entries.filter((d) => !d.isDirectory() && isCredentialPath(d.name)).length : 0;
  const count = named + (await sizeTree(join(root, 'secrets'), ctx.limit, ctx.limits.sizeMaxEntries)).count;
  return row(ctx, root, 'claude', 'credentials', count ? 'excluded' : 'not-found', { count, note: 'names only, never read' });
}

/** Codex sessions, history and databases (sized), `auth.json` (presence only), plugin contents (record only). */
export async function codexData(ctx: CoverageContext, root: string): Promise<CoverageEntry[]> {
  const cap = ctx.limits.sizeMaxEntries;
  const [live, archived, dbs, auth, history] = await Promise.all([
    sizeTree(join(root, 'sessions'), ctx.limit, cap),
    sizeTree(join(root, 'archived_sessions'), ctx.limit, cap),
    listFlatFiles(root, ctx.limit, (n) => /\.(sqlite|db)$/i.test(n)),
    lstatSize(join(root, 'auth.json'), ctx.limit),
    sizedFile(ctx, root, 'codex', 'history', 'history.jsonl'),
  ]);
  const dbSizes = await Promise.all(dbs.files.map((f) => lstatSize(f.abs, ctx.limit)));
  return [
    row(ctx, root, 'codex', 'sessions', live.found || archived.found ? 'not-scanned' : 'not-found', {
      count: live.count + archived.count, bytes: live.bytes + archived.bytes, note: PHASE_D_NOTE,
    }),
    history,
    row(ctx, root, 'codex', 'databases', dbSizes.length ? 'not-scanned' : 'not-found', {
      count: dbSizes.length, bytes: dbSizes.reduce<number>((a, b) => a + (b ?? 0), 0), note: PHASE_D_NOTE,
    }),
    row(ctx, root, 'codex', 'credentials', auth !== null ? 'excluded' : 'not-found', {
      count: auth !== null ? 1 : 0, note: 'presence only, never read',
    }),
    row(ctx, root, 'codex', 'plugin-contents', 'not-scanned', { note: 'record only' }),
  ];
}

/** The categories a project scan covers, per agent (mirrors `adaptProject`). */
const PROJECT_CATEGORIES: ReadonlyArray<readonly [ResourceAgent, readonly CoverageCategory[]]> = [
  ['claude', ['skill', 'command', 'rule', 'agent', 'settings', 'hook', 'mcp', 'instructions']],
  ['codex', ['skill', 'command', 'settings', 'hook', 'mcp', 'instructions']],
  ['shared', ['skill']],
];

/** A project folder the scan may not open: every category it would have covered reads `inaccessible`. */
export function inaccessibleProjectCoverage(ctx: CoverageContext, project: ProjectRecord): CoverageEntry[] {
  const note = 'folder could not be read (permission denied) — not scanned';
  return PROJECT_CATEGORIES.flatMap(([agent, categories]) =>
    categories.map((category) => row(ctx, project.absPath, agent, category, 'inaccessible', { note })));
}

/** Coverage note for a listing: its file cap, and the linked folders it did not follow. */
export function listingNote(tree: { capped: boolean; linkedDirs: number }, maxFiles: number): string | undefined {
  const notes = [
    ...(tree.capped ? [`capped at ${maxFiles.toLocaleString('en-US')} files`] : []),
    ...(tree.linkedDirs ? [`${tree.linkedDirs} linked ${tree.linkedDirs === 1 ? 'folder' : 'folders'} not followed`] : []),
  ];
  return notes.length ? notes.join('; ') : undefined;
}
