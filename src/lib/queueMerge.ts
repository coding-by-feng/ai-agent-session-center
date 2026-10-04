/**
 * @module queueMerge
 * Three-way merge of ONE session's prompt queue, by item id.
 *
 * Why this exists: the queue is shared by whole-list writes. Every window pushes
 * its entire list a moment after each edit, and the server keeps the last list it
 * was given. With one writer that is fine. With two (the docked queue and a float,
 * or two devices) it is not: window F pushes a list built before it saw that window
 * M had sent an item and removed it, M applies that list wholesale, and the item is
 * back — to be sent a second time. M's own pending push (built before F's arrived)
 * then overwrites the server with a list that has lost what F just added.
 *
 * So a window holding edits the server has not seen yet does not replace its list
 * with the incoming one. It merges, from three lists:
 *
 *   base   — what this window last knew the server to hold
 *   local  — what it holds now (base + its pending edits)
 *   remote — what just arrived
 *
 * and pushes the result. The rules, per item id:
 *
 *   - Remote order wins, and remote items come first.
 *   - An item this window removed since base stays removed, even though remote
 *     still lists it. Removal is usually the scheduler consuming a sent item, and
 *     bringing it back sends the prompt twice.
 *   - An item the remote removed stays removed, even if this window edited it.
 *     (A deletion beats an edit: the edit would only resurrect it.)
 *   - An item both sides hold is merged field by field: every field this window
 *     changed since base keeps this window's value (one both sides changed goes to
 *     this window), every other field takes the remote's, so an edit made
 *     elsewhere still lands. By field, not by item, because the scheduler keeps
 *     rewriting an item's own bookkeeping (lastFiredAt, nextFireAt, execState) in
 *     one window while its text is being edited in another, and keeping either
 *     side's whole copy would throw the other's change away.
 *   - An item only this window has, and base never had, is its own pending add:
 *     kept, after the remote items.
 *
 * It is NOT a protocol. Two pushes that are on the wire at the same moment are
 * still resolved by whichever the server handles last; this only covers the long
 * window in which one side's push is waiting out its debounce. See
 * `queueStore.applyRemoteQueue`.
 *
 * Pure and dependency-free (a type import only), like the other queue helpers, so
 * the rules are testable without a store.
 */
import type { QueueItem } from '@/stores/queueStore';

/**
 * Fields that do not make an item "changed". `position` is the item's place in the
 * list, which the merge decides; `sessionId` is the key the list lives under, which
 * differs only when a window has re-keyed the session first.
 */
const IGNORED_FIELDS: ReadonlySet<string> = new Set(['position', 'sessionId']);

/** Structural equality for JSON-shaped values; an `undefined` field equals an absent one. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameValue(value, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!sameValue(left[key], right[key])) return false;
  }
  return true;
}

/** The fields (other than the ignored ones) on which two items differ. */
function changedFields(from: QueueItem, to: QueueItem): string[] {
  const before = from as unknown as Record<string, unknown>;
  const after = to as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !IGNORED_FIELDS.has(key) && !sameValue(before[key], after[key]));
}

/**
 * The one item both sides hold. `before` is its copy in base, if base had one: with
 * none there is nothing to say which side changed what, and this window's copy is the
 * one carrying the edits it is trying not to lose.
 */
function mergeItem(before: QueueItem | undefined, mine: QueueItem, theirs: QueueItem): QueueItem {
  if (!before) return mine;
  const mineChanged = changedFields(before, mine);
  if (mineChanged.length === 0) return theirs;

  const merged = { ...theirs } as unknown as Record<string, unknown>;
  const local = mine as unknown as Record<string, unknown>;
  for (const key of mineChanged) {
    // A field this window cleared is cleared in the result too, not left at the remote's value.
    if (local[key] === undefined) delete merged[key];
    else merged[key] = local[key];
  }
  return merged as unknown as QueueItem;
}

/**
 * Merge `local` and `remote` against the `base` both descend from. Returns a new
 * list with dense positions; none of the inputs is modified. See the module comment
 * for the rules.
 */
export function mergeQueueItems(
  base: readonly QueueItem[],
  local: readonly QueueItem[],
  remote: readonly QueueItem[],
): QueueItem[] {
  const baseById = new Map(base.map((it) => [it.id, it]));
  const localById = new Map(local.map((it) => [it.id, it]));
  const remoteIds = new Set(remote.map((it) => it.id));

  const merged: QueueItem[] = [];

  for (const theirs of remote) {
    const before = baseById.get(theirs.id);
    const mine = localById.get(theirs.id);
    if (!mine) {
      // Gone here. If base had it, this window removed it: it stays gone.
      // If base never had it, it is someone else's add.
      if (!before) merged.push(theirs);
      continue;
    }
    merged.push(mergeItem(before, mine, theirs));
  }

  for (const mine of local) {
    if (remoteIds.has(mine.id)) continue;
    // Base had it and remote does not: the remote removed it, and that wins.
    if (baseById.has(mine.id)) continue;
    merged.push(mine);
  }

  return merged.map((it, index) => (it.position === index ? it : { ...it, position: index }));
}
