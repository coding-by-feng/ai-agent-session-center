/**
 * Project Sync review decisions: a repository decided as one unit, single entries, or every
 * entry of one kind. A request is checked whole before anything changes, so a refused
 * decision leaves the plan exactly as it was.
 */
import { randomUUID } from 'crypto';
import { repoEntryAction } from './classify.js';
import { SyncError } from './errors.js';
import {
  possibleActions,
  type SyncAction,
  type SyncChange,
  type SyncDirection,
  type SyncEntry,
  type SyncGroup,
  type SyncGroupDecision,
} from '../../src/types/projectSync.js';

export interface DecisionRequest {
  entries?: Record<string, SyncAction>;
  groups?: Record<string, SyncGroupDecision>;
  bulk?: { change: SyncChange; action: SyncAction };
}

/** The decision a repository may take in this state, or why it may not. */
function refuseGroup(
  g: SyncGroup,
  decision: SyncGroupDecision,
  direction: SyncDirection,
): string | null {
  const choices: SyncGroupDecision[] =
    direction === 'two-way'
      ? ['sync', 'overwrite', 'take-device', 'skip']
      : ['sync', 'overwrite', 'skip'];
  if (g.state === 'busy') return 'Git is busy in that repository. Compare again when it finishes.';
  if (!choices.includes(decision)) return 'Invalid repository decision.';
  if (decision !== 'sync') return null;
  if (direction === 'two-way' && (g.state === 'both-changed' || g.state === 'different-repo'))
    return "Both copies of this repository changed: use this computer's, use the server's, or Skip.";
  if (direction === 'push' && (g.state === 'device-changed' || g.state === 'different-repo'))
    return 'The server copy of this repository changed: choose Overwrite or Skip.';
  return null;
}

/**
 * Applies a review's decisions to its plan. `nameCopy` names keep-both's copy of the
 * server's file. Returns the entries that changed; throws before changing any when one
 * decision is not possible.
 */
export function applyDecisions(
  plan: { entries: SyncEntry[]; groups: SyncGroup[] },
  body: DecisionRequest,
  direction: SyncDirection,
  nameCopy: (path: string) => string,
): SyncEntry[] {
  const repos = new Map(plan.groups.filter((g) => g.isRepo).map((g) => [g.id, g]));
  const byId = new Map(plan.entries.map((e) => [e.id, e]));
  const groupSteps: [SyncGroup, SyncGroupDecision][] = [];
  for (const [groupId, decision] of Object.entries(body.groups ?? {})) {
    const g = repos.get(groupId);
    if (!g) throw new SyncError('Only repositories are decided as a group.', 400);
    const why = refuseGroup(g, decision, direction);
    if (why) throw new SyncError(why, why.startsWith('Invalid') ? 400 : 409);
    groupSteps.push([g, decision]);
  }
  const entrySteps: [SyncEntry, SyncAction][] = [];
  for (const [id, a] of Object.entries(body.entries ?? {})) {
    const e = byId.get(id);
    if (!e) throw new SyncError('Entry not found.', 404);
    if (repos.has(e.groupId))
      throw new SyncError('Decide repository files with the repository row.', 400);
    if (!possibleActions(e, direction).includes(a))
      throw new SyncError(`"${a}" is not possible for ${e.path}.`, 400);
    entrySteps.push([e, a]);
  }
  if (body.bulk)
    for (const e of plan.entries)
      if (
        e.change === body.bulk.change &&
        !repos.has(e.groupId) &&
        possibleActions(e, direction).includes(body.bulk.action)
      )
        entrySteps.push([e, body.bulk.action]);

  const touched = new Set<SyncEntry>();
  for (const [g, decision] of groupSteps) {
    g.decision = decision;
    for (const e of plan.entries)
      if (e.groupId === g.id) {
        e.action = repoEntryAction(e, decision, direction, g.state);
        touched.add(e);
      }
  }
  for (const [e, a] of entrySteps) {
    if (a === 'keep-both' && !(e.copyPath && e.copyId)) {
      e.copyPath = nameCopy(e.path);
      e.copyId = randomUUID();
    } else if (a !== 'keep-both') {
      delete e.copyPath;
      delete e.copyId;
    }
    e.action = a;
    touched.add(e);
  }
  return [...touched];
}
