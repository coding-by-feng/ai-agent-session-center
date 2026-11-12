/** Project Sync run summaries: counts, bytes each way, and the warnings a review shows first. */
import {
  isActing,
  type SyncChange,
  type SyncDirection,
  type SyncEntry,
  type SyncRun,
} from '../../src/types/projectSync.js';

/** Bytes an acting entry moves: this computer → server, and server → this computer. */
function bytesOf(e: SyncEntry): { send: number; get: number } {
  const L = e.local?.kind === 'file' ? e.local.size : 0;
  const R = e.device?.kind === 'file' ? e.device.size : 0;
  if (e.action === 'push') return { send: L, get: 0 };
  if (e.action === 'pull') return { send: 0, get: R };
  // keep-both: the server's file comes here as the copy, then both files go to the server.
  if (e.action === 'keep-both') return { send: L + R, get: R };
  return { send: 0, get: 0 };
}

/** Recounts a run from its entries. Bytes already moved (`sent`, `got`) are kept. */
export function summarize(r: SyncRun, entries: SyncEntry[]) {
  const counts: Partial<Record<SyncChange, number>> = {};
  let toSend = 0,
    toGet = 0,
    total = 0,
    done = 0,
    failed = 0,
    pending = 0;
  const repoGroups = new Set(r.groups.filter((g) => g.isRepo).map((g) => g.id));
  for (const e of entries) {
    counts[e.change] = (counts[e.change] ?? 0) + 1;
    if (isActing(e.action)) {
      total++;
      if (e.state === 'done') done++;
      if (e.state === 'failed') failed++;
      const b = bytesOf(e);
      toSend += b.send;
      toGet += b.get;
    }
    if (e.action === 'review' && !repoGroups.has(e.groupId)) pending++;
  }
  pending += r.groups.filter((g) => g.isRepo && g.decision === 'review').length;
  Object.assign(r, { counts, total, done, failed, pendingDecisions: pending });
  r.bytes = { toSend, sent: r.bytes?.sent ?? 0, toGet, got: r.bytes?.got ?? 0 };
}

/** At least this many deletes on one side, and at least half of what was synced, are a mass delete. */
const MASS_DELETES = 5;
const isMass = (deletes: number, synced: number) =>
  deletes >= MASS_DELETES && deletes * 2 >= synced;

/**
 * The question a run asks before it deletes half or more of what was synced on one side: that
 * side's folder may be incomplete (a failed checkout, a wiped folder, nothing mounted). Counts
 * what is still to do, so a retry asks again only for deletes still ahead. Null when it need not ask.
 */
export function massDeleteAsk(entries: SyncEntry[]): string | null {
  let here = 0,
    there = 0,
    synced = 0;
  for (const e of entries) {
    if (!e.base) continue; // only what was synced: a first run's deletes are a repository's choice
    synced++;
    if (e.state === 'done' || e.state === 'skipped') continue;
    if (e.action === 'delete-local') here++;
    else if (e.action === 'delete-device') there++;
  }
  if (isMass(here, synced))
    return `This run deletes ${here} of ${synced} synced files on this computer (undo keeps them). Is the server folder complete?`;
  if (isMass(there, synced))
    return `This run deletes ${there} of ${synced} synced files on the server (to its trash). Is the project folder here complete?`;
  return null;
}

export function warningsFor(entries: SyncEntry[], direction: SyncDirection): string[] {
  const n = (flag: SyncEntry['flags'][number]) =>
    entries.filter((e) => e.flags.includes(flag) && e.change !== 'same').length;
  const w: string[] = [];
  const creds = entries.filter((e) => e.flags.includes('credential')).length;
  if (creds)
    w.push(
      `${creds} credential file${creds === 1 ? '' : 's'} (such as .env) will be copied as-is. Their contents are never shown here.`,
    );
  if (n('live-db'))
    w.push('A database is open (it has a -wal file): its copy may be inconsistent.');
  if (n('native-artifact'))
    w.push(
      'Native modules built for this computer will not run on the server (different platform).',
    );
  if (n('link-outside'))
    w.push('Some links point outside the project; the other side may not have their targets.');
  if (n('git-config'))
    w.push(
      'The server changed or deleted a git config file (.git/config, or a submodule’s or worktree’s). Git reads it on every command here, and a changed one can run programs: check it before you choose.',
    );
  const executables = n('executable');
  if (executables)
    w.push(
      executables === 1
        ? '1 executable file comes from the server. Check it before you run it.'
        : `${executables} executable files come from the server. Check them before you run them.`,
    );
  const based = entries.filter((e) => e.base).length;
  const goneHere = entries.filter((e) => e.change === 'delete').length;
  if (isMass(goneHere, based))
    w.unshift(
      `${goneHere} of ${based} synced files are gone on this computer and would be deleted on the server (to its trash). Is the project folder complete?`,
    );
  if (direction === 'two-way') {
    const goneThere = entries.filter((e) => e.change === 'drift' && !e.device).length;
    if (isMass(goneThere, based))
      w.unshift(
        `${goneThere} of ${based} synced files are gone on the server and would be deleted here (kept for undo). Is the server folder complete?`,
      );
  }
  const collisions = n('case-collision');
  if (collisions)
    w.push(
      collisions === 1
        ? '1 path differs only in letter case or accents between this computer and the server and is skipped. Rename one side to match.'
        : `${collisions} paths differ only in letter case or accents between this computer and the server and are skipped. Rename one side to match.`,
    );
  if (n('worktree-gitdir'))
    w.push(
      'A linked git worktree points at a folder on this computer; it will not work on the server.',
    );
  return w;
}
