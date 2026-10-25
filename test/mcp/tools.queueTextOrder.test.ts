// test/mcp/tools.queueTextOrder.test.ts — P4-32 M5: a queued text that starts with a command is checked against the
// session's catalog (an HTTP call), and the steering rails are judged AFTER it, right before the write. Rails judged
// first could go stale across the await: a person who starts typing into the session while the catalog is read must
// still stop the central's write.
import { describe, expect, it } from 'vitest';
import type { CommandEntry } from '../../server/commandIndex.js';
import { standardRows, queueWorld, worker } from './queueToolFixtures.js';
import { NOW, ok } from './toolHarness.js';

const DEPLOY: CommandEntry = { name: 'deploy', description: 'x', cli: 'claude', kind: 'command', source: 'project' };

/** A session a person starts driving the moment the catalog is asked for. */
function worldWherePersonTypesDuringCatalog() {
  let personTyping = false;
  return queueWorld({
    sessions: [worker('s1', { cliSource: 'claude', projectPath: '/a/proj' })],
    rows: standardRows(),
    unlocked: true,
    routes: {
      'GET /commands': () => {
        personTyping = true;
        return ok({ entries: [DEPLOY] });
      },
    },
    controller: () => (personTyping ? { clientId: 'window-1', lastActivityAt: NOW - 1_000 } : null),
  });
}

const CASES: Array<[string, Record<string, unknown>]> = [
  ['queue_add_item', { id: 's1', text: '/deploy staging' }],
  ['queue_edit_item', { id: 's1', itemId: 1, text: '/deploy staging' }],
  ['queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: '/deploy staging' }],
  ['queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: '/deploy staging' }],
  ['queue_set_automation', { id: 's1', resumePrompt: '/deploy staging' }],
];

describe('the steering rails are judged after the catalog is read', () => {
  it.each(CASES)('%s writes nothing when a person started driving during the catalog call', async (name, args) => {
    const w = worldWherePersonTypesDuringCatalog();

    const err = await w.refused(name, args);

    expect(err.code).toBe('HUMAN_ACTIVE');
    expect(w.store.writes).toEqual([]);
  });

  it.each(CASES)('%s still writes when nobody drove the session', async (name, args) => {
    const w = queueWorld({
      sessions: [worker('s1', { cliSource: 'claude', projectPath: '/a/proj' })],
      rows: standardRows(),
      unlocked: true,
      routes: { 'GET /commands': ok({ entries: [DEPLOY] }) },
    });

    await w.call(name, args);

    expect(w.store.writes).toHaveLength(1);
  });
});
