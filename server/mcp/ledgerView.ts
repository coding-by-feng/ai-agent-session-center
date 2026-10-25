// ledgerView.ts — the task ledger (ledger.ts) as one central sees it: ToolContext.ledger (callContext.ts).

import type { Room } from '../../src/types/room.js';
import { envelopeLabel } from './ledgerTurn.js';
import type { Ledger, TaskRecord } from './ledgerTypes.js';
import { ToolError, type CentralRecord } from './types.js';

/**
 * `ledger` as `central` sees it: its own tasks only (another central's are not there: get answers null, list and
 * wait leave them out, cancel and retarget are NOT_FOUND), tasks recorded as itself only, its envelope labelled from
 * the rooms as they are. The lock still spans every central (`isLocked`, and `create`'s BUSY): only the central's own
 * task may be left out of it.
 */
export function ledgerFor(ledger: Ledger, central: CentralRecord, rooms: () => readonly Room[]): Ledger {
  const own = (t: TaskRecord | null): TaskRecord | null => (t !== null && t.centralId === central.centralId ? t : null);
  return {
    create(i) {
      if (i.central.centralId !== central.centralId) {
        throw new ToolError('INVALID', 'A central records tasks as itself only.', 'Pass your own central (ctx.central).');
      }
      return ledger.create({ ...i, central, label: i.label ?? envelopeLabel(central, rooms()) });
    },
    get: (id) => own(ledger.get(id)),
    list: (f) => ledger.list({ ...f, centralId: central.centralId }),
    isLocked: (sessionId, exceptTaskId) =>
      ledger.isLocked(sessionId, exceptTaskId !== undefined && own(ledger.get(exceptTaskId)) !== null ? exceptTaskId : undefined),
    isFromBeforeRestart: (id) => ledger.isFromBeforeRestart(id),
    wait: (ids, timeoutMs, signal) => ledger.wait(ids.filter((id) => own(ledger.get(id)) !== null), timeoutMs, signal),
    cancel: (id, _centralId, opts) => ledger.cancel(id, central.centralId, opts),
    retarget: (id, _centralId, session) => ledger.retarget(id, central.centralId, session),
    onChange: (listener) =>
      ledger.onChange((t) => {
        if (t.centralId === central.centralId) listener(t);
      }),
  };
}
