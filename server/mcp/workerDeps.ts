// workerDeps.ts — what the P4 tools hand the router (router.ts) and the worker opener (openWorker.ts) on the live
// server: the one place their real dependencies are built (Ruling P4-18), so every caller (session_create,
// task_delegate to "auto", project_resolve, task_route, the re-router) opens and routes with the same ones.
//
//   known roots  GET /known-projects: the folders the CLI has worked in, the list the router judges a launch by, so a
//                dry run (task_route) and the open agree on what is a known project (autoConfirmTrust, dot folders)
//   realpath     fs.promises.realpath: a link is judged by where it leads
//   plan window  the freshest 5-hour plan-window reading any session of that CLI carries (as aasc_plan_usage reads it),
//                none once that window's reset time has passed
//   home         this user's home folder
//
// Tool tests replace this module (vi.mock) so nothing they run reaches the disk; workerDeps.test.ts holds the real one.

import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import { bodyOf, rowsOf } from './apiBody.js';
import type { OpenWorkerDeps } from './openWorker.js';
import type { ToolContext } from './registry.js';
import type { RouteDeps } from './router.js';
import type { CliKind } from './types.js';

/** The 5-hour plan window, in minutes (planUsageCodec.ts `FIVE_HOUR_MINUTES`). */
const FIVE_HOURS = 300;

const knownSchema = z.object({ paths: z.array(z.unknown()) });

/** The known project roots (GET /known-projects); none when the route does not answer. */
export async function knownRootsOf(ctx: Pick<ToolContext, 'client'>): Promise<string[]> {
  const parsed = knownSchema.safeParse(bodyOf(await ctx.client.get('/known-projects')));
  return parsed.success ? rowsOf(parsed.data.paths, z.string()) : [];
}

/**
 * How full the CLI's 5-hour plan window is, 0–100, from the newest reading any session carries; null when none does,
 * or when that window's reset time has passed by `now` (the reading is of a window that is over: with no session of
 * that CLI running since, nothing would ever replace it). The limits are the account's, so every session of a CLI
 * carries the same reading.
 */
export function planWindowPct(sessions: readonly Session[], cli: CliKind, now: number): number | null {
  const newest = sessions
    .flatMap((s) => (s.planUsage && s.planUsage.cli === cli ? [s.planUsage] : []))
    .sort((a, b) => b.asOf - a.asOf)[0];
  const window = newest?.windows.find((w) => w.minutes === FIVE_HOURS);
  if (window === undefined || !Number.isFinite(window.usedPercent)) return null;
  if (window.resetsAt !== null && window.resetsAt <= now) return null;
  return window.usedPercent;
}

/** The worker opener's dependencies for a call by this context's central. */
export function openWorkerDepsFor(ctx: ToolContext): OpenWorkerDeps {
  return {
    knownProjects: () => knownRootsOf(ctx),
    home: homedir(),
    realpath: (p) => realpath(p),
    planWindowPct: (cli) => planWindowPct(ctx.sessions(), cli, ctx.now()),
    now: () => ctx.now(),
  };
}

/** The router's dependencies: its own defaults (the settings file, the disk, GET /known-projects) and this home. */
export function routeDepsFor(_ctx: ToolContext): RouteDeps {
  return { home: homedir() };
}
