/**
 * The plan-usage chip's click: ask the server to re-read the CLI's usage now and
 * keep where that stands. State is per CLI, not per session: plan usage belongs to
 * the account, so the answer carries across the sessions of one CLI and is dropped
 * when the CLI changes.
 *
 * Two rules the UI leans on:
 *  - The busy state lasts at least `MIN_SYNCING_MS`. A local re-read answers in a few
 *    milliseconds, and a click that shows nothing reads as a click that did nothing.
 *  - A click while one is in flight is ignored, and the control stays enabled
 *    (`aria-busy`, never `disabled`): a button that disables itself drops keyboard focus.
 *
 * A failure is also a toast: the panel that says it is a hover tooltip, which a touch
 * screen never shows. An answer ("up to date") is not: it is news only to someone looking.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import { syncPlanUsage } from '@/lib/planUsageApi';
import type { PlanUsageSyncState } from '@/lib/planUsage';
import type { PlanCli } from '@/types/session';

export const MIN_SYNCING_MS = 600;

const IDLE: PlanUsageSyncState = { status: 'idle' };

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function useSyncPlanUsage(cli: PlanCli | null): { state: PlanUsageSyncState; sync: () => void } {
  const [state, setState] = useState<PlanUsageSyncState>(IDLE);
  const [stateCli, setStateCli] = useState(cli);
  const busy = useRef(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);

  // Adjusting state when a prop changes: during render, not in an effect (react-hooks/set-state-in-effect).
  if (stateCli !== cli) {
    setStateCli(cli);
    setState(IDLE);
  }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  const sync = useCallback(() => {
    if (!cli || busy.current) return;
    busy.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setState({ status: 'syncing' });
    void (async () => {
      const [outcome] = await Promise.all([
        syncPlanUsage(cli, abort.signal).then(
          (reply) => ({ reply }),
          () => ({ reply: null }),
        ),
        wait(MIN_SYNCING_MS),
      ]);
      busy.current = false;
      if (!alive.current) return;
      if (!outcome.reply) showToast("Couldn't sync plan usage", 'error');
      setState(
        outcome.reply
          ? { status: 'done', checkedAt: outcome.reply.checkedAt, changed: outcome.reply.changed }
          : { status: 'failed' },
      );
    })();
  }, [cli]);

  return { state, sync };
}
