/**
 * Project Sync run: carries a reviewed plan out in two passes. This computer receives first
 * (pulls, local deletes, keep-both's copy of the server's file), streamed from the server's
 * helper; then the server receives (pushes, server deletes, keep-both's two files). An entry
 * is done when every operation it owns is done, and only then does the base move.
 */
import log from '../logger.js';
import { redactSecretsInString } from '../resourceMask.js';
import { applyOrder, type ApplyOp, type ApplySide } from './classify.js';
import { clean, SyncError } from './errors.js';
import {
  applyOps,
  openExport,
  probe,
  undoRun,
  type Ack,
  type Exporter,
  type FileSource,
  type Launcher,
} from './helperClient.js';
import type { StoredLink, SyncStore } from './store.js';
import { summarize } from './summary.js';
import {
  isActing,
  LOCAL_ACTIONS,
  SERVER_ACTIONS,
  type FileMeta,
  type SyncEntry,
  type SyncRun,
} from '../../src/types/projectSync.js';

export interface RunContext {
  store: SyncStore;
  launchLocal: Launcher;
  /** The link's server, already pinned. */
  launchDevice: Launcher;
  /** Persist progress at most this often (ms). */
  saveEveryMs: number;
  /** True once the user cancelled. */
  stopped: () => boolean;
  saveRun: (r: SyncRun) => Promise<void>;
}

const NOT_APPLIED = 'Not applied. Retry continues where it stopped.';

/** Runs the pending entries of `r` and settles its final state. Never throws. */
export async function executeRun(
  ctx: RunContext,
  r: SyncRun,
  l: StoredLink,
  entries: SyncEntry[],
): Promise<void> {
  const { store, stopped } = ctx;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const dirty = new Map<string, SyncEntry>();
  let lastSave = Date.now();
  const flush = async () => {
    const list = [...dirty.values()];
    dirty.clear();
    summarize(r, entries);
    if (list.length) await store.saveEntries(r.id, list);
    await ctx.saveRun(r);
    lastSave = Date.now();
  };
  const touch = (e: SyncEntry) => {
    dirty.set(e.id, e);
    if (Date.now() - lastSave > ctx.saveEveryMs)
      void flush().catch((err) => log.warn('project-sync', `Progress not saved: ${clean(err)}`));
  };
  const unfinished = (e: SyncEntry) => {
    e.state = stopped() ? 'pending' : 'failed';
    if (e.state === 'failed') e.error = r.error ?? NOT_APPLIED;
    touch(e);
  };
  /** Operations each entry still waits on, and the keep-both copies that reached this computer. */
  const left = new Map<string, number>();
  const copied = new Set<string>();
  const settle = (e: SyncEntry | undefined, ack: Ack) => {
    if (!e || e.state !== 'applying') return;
    if (ack.state === 'done') {
      const n = (left.get(e.id) ?? 1) - 1;
      left.set(e.id, n);
      if (n > 0) return;
      e.state = 'done';
      delete e.error;
    } else {
      e.state = ack.state;
      if (ack.error) e.error = redactSecretsInString(ack.error).slice(0, 300);
    }
    touch(e);
  };
  const pass = async (ops: ApplyOp[], side: ApplySide, source: string | FileSource) => {
    if (!ops.length || stopped()) return;
    const ownerOf = new Map(ops.map((o) => [o.entryId, o.owner]));
    const acked = new Set<string>();
    try {
      await applyOps(
        side === 'local' ? ctx.launchLocal : ctx.launchDevice,
        side === 'local'
          ? { root: l.localRoot, linkId: l.id, runId: r.id, side: 'local' }
          : { root: l.remoteRoot, linkId: l.id, runId: r.id },
        source,
        ops,
        {
          cancelled: stopped,
          onSent: (n) => {
            if (side === 'local') r.bytes.got = (r.bytes.got ?? 0) + n;
            else r.bytes.sent += n;
          },
          onAck: (ack) => {
            acked.add(ack.id);
            const e = byId.get(ownerOf.get(ack.id) ?? '');
            if (side === 'local' && ack.state === 'done' && e?.action === 'keep-both')
              copied.add(e.id);
            settle(e, ack);
          },
        },
      );
    } catch (err) {
      r.error ??= clean(err);
    }
    for (const o of ops) {
      const e = byId.get(o.owner)!;
      if (!acked.has(o.entryId) && e.state === 'applying') unfinished(e);
    }
  };
  try {
    const pending = entries.filter((e) => e.state === 'pending');
    const held = (pick: (e: SyncEntry) => FileMeta | undefined) =>
      new Map<string, FileMeta>(entries.filter((e) => pick(e)).map((e) => [e.path, pick(e)!]));
    const localOps = applyOrder(
      pending,
      held((e) => e.local),
      'local',
    );
    const deviceOps = applyOrder(
      pending,
      held((e) => e.device),
      'device',
    );
    for (const o of [...localOps, ...deviceOps]) left.set(o.owner, (left.get(o.owner) ?? 0) + 1);
    // Acting entries with no operation are already true where they act (a delete of
    // something already gone).
    for (const e of pending) {
      if (!isActing(e.action)) continue;
      if (e.action === 'keep-both' && !(e.copyPath && e.copyId)) {
        e.state = 'failed';
        e.error = 'Choose Keep both again: its copy has no name.';
      } else e.state = left.has(e.id) ? 'applying' : 'done';
      dirty.set(e.id, e);
    }
    if (localOps.length && !stopped()) {
      let exporter: Exporter | null = null;
      try {
        exporter = await openExport(ctx.launchDevice, { root: l.remoteRoot, inHome: true });
      } catch (err) {
        r.error ??= clean(err);
      }
      if (exporter)
        try {
          await pass(localOps, 'local', { kind: 'remote', exporter });
        } finally {
          await exporter.close();
        }
    }
    // The server is written only after this computer holds keep-both's copy of its file.
    await pass(
      deviceOps.filter((o) => {
        const e = byId.get(o.owner)!;
        return e.state === 'applying' && (e.action !== 'keep-both' || copied.has(e.id));
      }),
      'device',
      l.localRoot,
    );
    for (const e of entries) if (e.state === 'applying') unfinished(e);
    await saveBase(store, l, nextBase(entries));
  } catch (err) {
    // Never leave a run "running": a store failure ends it as failed with its reason.
    r.error = r.error ?? clean(err);
    for (const e of entries)
      if (e.state === 'applying') {
        e.state = 'failed';
        e.error = r.error;
        dirty.set(e.id, e);
      }
  } finally {
    summarize(r, entries);
    r.state = stopped()
      ? 'cancelled'
      : r.failed === 0 && !r.error
        ? 'complete'
        : r.done > 0
          ? 'partial'
          : 'failed';
    if (r.state === 'complete') delete r.error;
    await flush().catch((err) => log.error('project-sync', `Run ${r.id} not saved: ${clean(err)}`));
  }
}

/**
 * The base after a run: what both sides hold for certain, rebuilt from this plan and never
 * patched. A path the plan does not list (gone on both sides) leaves the base; a path the
 * run did not finish keeps the row the compare read (none when it compared without a base,
 * on a first run or a restart), so the next compare finds the same change again.
 */
export function nextBase(entries: SyncEntry[]): Map<string, FileMeta> {
  const base = new Map<string, FileMeta>();
  const hold = (path: string, meta: FileMeta | undefined) => {
    if (meta) base.set(path, meta);
  };
  for (const e of entries) {
    if (e.change === 'same') hold(e.path, e.local);
    // Push: the server keeps a file this computer deleted; it is no longer synced.
    else if (e.change === 'delete' && e.action === 'keep') continue;
    else if (e.state !== 'done') hold(e.path, e.base);
    else if (e.action === 'push') hold(e.path, e.local);
    else if (e.action === 'pull') hold(e.path, e.device);
    else if (e.action === 'keep-both') {
      hold(e.path, e.local);
      if (e.copyPath) hold(e.copyPath, e.device);
    }
    // delete-device / delete-local: gone on both sides.
  }
  return base;
}

/** Stores a link's base; an empty one makes the next compare a first run. */
export async function saveBase(store: SyncStore, l: StoredLink, base: Map<string, FileMeta>) {
  await store.replaceBase(l.id, base);
  l.hasBase = base.size > 0;
  l.updatedAt = Date.now();
  await store.saveLink(l);
}

export interface UndoContext {
  store: SyncStore;
  launchLocal: Launcher;
  /** The link's server, already pinned. */
  launchDevice: Launcher;
  saveRun: (r: SyncRun) => Promise<void>;
}

/**
 * Puts back what run `r` of link `l` changed, on each side it wrote to (the server first), and
 * forgets the base. The caller holds the one-at-a-time slot. Throws a SyncError the user can act on.
 */
export async function undoRunSides(
  ctx: UndoContext,
  r: SyncRun,
  l: StoredLink,
  entries: SyncEntry[],
): Promise<{ restored: number; skipped: number }> {
  const toServer = entries.some((e) => SERVER_ACTIONS.has(e.action));
  const toLocal = entries.some((e) => LOCAL_ACTIONS.has(e.action));
  // Reach the server before anything changes: one that cannot answer would leave the run
  // stale and the base forgotten with nothing put back.
  if (toServer)
    try {
      await probe(ctx.launchDevice);
    } catch (e) {
      throw new SyncError(`Could not reach the server: ${clean(e)} Nothing was undone.`);
    }
  const before = await ctx.store.loadBase(l.id);
  const staleBefore = r.stale;
  /** Nothing was put back: the base and the plan still hold. */
  const rollBack = async () => {
    r.stale = staleBefore;
    if (r.stale === undefined) delete r.stale;
    await saveBase(ctx.store, l, before);
    await ctx.saveRun(r);
  };
  // Once undo begins, this plan describes neither side: a Retry would rebuild the base from it.
  r.stale =
    'Undo began on this run. Undo again to finish it; a new compare gives up the rest of the undo.';
  try {
    await ctx.saveRun(r);
    // Forget the base before anything is put back: an undo that stops partway leaves neither
    // side matching it, and a stale base would read the undone files as fresh edits. The
    // next compare runs as a first run, which never deletes.
    await saveBase(ctx.store, l, new Map());
  } catch (e) {
    await rollBack().catch((err) =>
      log.error('project-sync', `Undo not rolled back: ${clean(err)}`),
    );
    throw new SyncError(`Could not start the undo: ${clean(e)} Nothing was undone.`);
  }
  const result = { restored: 0, skipped: 0 };
  let sides = 0;
  const undoSide = async (launch: Launcher, header: Parameters<typeof undoRun>[1]) => {
    try {
      const x = await undoRun(launch, header);
      result.restored += x.restored;
      result.skipped += x.skipped;
      sides++;
    } catch (e) {
      // That side never received anything from this run.
      if (!(e instanceof Error && e.message.startsWith('Nothing to undo'))) throw e;
    }
  };
  try {
    if (toServer)
      await undoSide(ctx.launchDevice, { root: l.remoteRoot, linkId: l.id, runId: r.id });
    if (toLocal)
      await undoSide(ctx.launchLocal, {
        root: l.localRoot,
        linkId: l.id,
        runId: r.id,
        side: 'local',
      });
  } catch (e) {
    throw new SyncError(`Undo stopped partway: ${clean(e)} Undo again to finish.`);
  }
  if (!sides) {
    // Neither side holds anything of this run: the base was still true, and so is the plan.
    await rollBack();
    throw new SyncError('Nothing from this run changed either side.');
  }
  r.state = 'undone';
  delete r.stale;
  r.warnings = [
    `Undo restored ${result.restored} item${result.restored === 1 ? '' : 's'}${result.skipped ? `; ${result.skipped} changed since and were left alone` : ''}.`,
    ...r.warnings,
  ];
  await ctx.saveRun(r);
  return result;
}
