/**
 * @module queueAutomationDiff
 * Which changes to the per-session queue switches (`queueStore.automation`) are
 * somebody's decision, and so worth a workspace-snapshot save, and which are
 * bookkeeping. Pure; type imports only.
 *
 * The map changes for three other reasons that decide nothing: `loadFromDb`
 * installs the rows at boot, a sync echo installs the value we already hold under
 * a new object, and `migrateSession` MOVES an entry to a new id when a `term-*`
 * card turns into its CLI session. The move is the one that matters. A save after
 * every re-key of a restore would write a snapshot while the slower cards are
 * still `term-*` placeholders, and a restore from THAT has nothing to `--resume`.
 */
import type { QueueAutomationConfig } from '@/stores/queueStore';

type Automation = ReadonlyMap<string, QueueAutomationConfig>;

const same = (a: QueueAutomationConfig, b: QueueAutomationConfig): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Did somebody change a switch between `prev` and `next` (not just move or re-install one)? */
export function automationIntentChanged(prev: Automation, next: Automation): boolean {
  const added: QueueAutomationConfig[] = [];
  for (const [id, cfg] of next) {
    const before = prev.get(id);
    if (before === undefined) added.push(cfg);
    else if (before !== cfg && !same(before, cfg)) return true; // a config that was already there changed
  }
  const removed: QueueAutomationConfig[] = [];
  for (const [id, cfg] of prev) if (!next.has(id)) removed.push(cfg);
  // A re-key is one removal plus one addition with the same switches. Pair each
  // addition with a removal; one with no partner was set by somebody.
  for (const cfg of added) {
    const partner = removed.findIndex((r) => same(r, cfg));
    if (partner === -1) return true;
    removed.splice(partner, 1);
  }
  return false;
}
