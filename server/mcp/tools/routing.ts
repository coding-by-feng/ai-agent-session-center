// tools/routing.ts — P4's two routing reads, in the tasks toolset: `project_resolve` (which project a task is about)
// and `task_route` (where task_delegate to "auto" would send it). Both run the router's own code (router.ts,
// resolveProject.ts) as the calling central, so they see what its scope lets it see, and both are dry runs: they read
// (the project index, the known projects, the candidates' edited files) and never open a session or type anything.
//
// They work whatever `mcp.autoRouting` says (Ruling P4-15): they are how a central picks from the top 5 itself when
// auto routing is off. What a central must act on (the confidence, the ask to name the project) is in `data`, not
// only in the text (Ruling 66). No answer holds text a session wrote: folders, names, ids, scores and AASC's words.

import { homedir } from 'node:os';
import { basename } from 'node:path';
import { z } from 'zod';
import { normalizeFolder } from '../paths.js';
import { listProjects } from '../projectIndex.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { fsExists, fsRealpath, type ProjectConfidence, type ProjectHints } from '../resolveProject.js';
import { explain, resolveProject, route, type RouteResult } from '../router.js';
import { TASK_TEXT_MAX } from '../ledger.js';
import { knownRootsOf, routeDepsFor } from '../workerDeps.js';
import { defineTool } from './define.js';

/** How many projects project_resolve lists. */
const TOP = 5;

/** What a central should do when AASC only guessed the project: in data, for every CLI (Ruling 66). */
export const NAME_THE_PROJECT =
  'AASC only guessed the project: name the project (project: a folder or name from project_resolve) or delegate to a session by id.';

/** A guess is a guess: low confidence (or none) asks the central to name the project. */
export const isLowConfidence = (c: ProjectConfidence): boolean => c === 'low' || c === 'none';

export const TASK_INPUT = z
  .string()
  .min(1)
  .max(TASK_TEXT_MAX)
  .describe('The task, in the words you would hand a session (at most 60 000 characters).');
const PROJECT_INPUT = z
  .string()
  .min(1)
  .max(1_024)
  .describe('The project: its folder (absolute or ~/…) or its name, as project_resolve lists it.');

// ---------------------------------------------------------------------------
// project_resolve
// ---------------------------------------------------------------------------

/** The hints as resolveProject takes them: only what the central gave. */
function hintsOf(folder: string | undefined, name: string | undefined): ProjectHints {
  return {
    ...(folder !== undefined && folder.trim() !== '' ? { folder: folder.trim() } : {}),
    ...(name !== undefined && name.trim() !== '' ? { name: name.trim() } : {}),
  };
}

async function resolveFor(ctx: ToolContext, task: string, hints: ProjectHints) {
  const deps = routeDepsFor(ctx);
  const home = normalizeFolder(deps.home ?? homedir());
  const [projects, known] = await Promise.all([listProjects(ctx, { home }), (deps.known ?? (() => knownRootsOf(ctx)))()]);
  const resolution = resolveProject(task, hints, projects, {
    central: ctx.central,
    home,
    known,
    exists: deps.exists ?? fsExists,
    realpath: deps.realpath ?? fsRealpath,
  });
  const names = new Map(projects.map((p) => [p.folder, p.name]));
  return { resolution, nameOf: (folder: string): string => names.get(folder) ?? basename(folder) };
}

const projectResolve: ToolDef = defineTool({
  name: 'project_resolve',
  toolset: 'tasks',
  title: 'Which project a task is about',
  description:
    'Says which project a task is about: up to 5 project folders in your scope, best first, each with a score (0-100) ' +
    'and why, and how sure AASC is (high, medium, low or none). Reads only. When confidence is low or none, name the ' +
    'project yourself (task_route or task_delegate take project:) or delegate to a session by id.',
  risk: 'read',
  phase: 4,
  input: {
    task: TASK_INPUT,
    folder: z.string().min(1).max(1_024).optional().describe('A folder you think it is about (absolute or ~/…).'),
    name: z.string().min(1).max(200).optional().describe('A project name you think it is about.'),
  },
  async run(args, ctx) {
    const { resolution, nameOf } = await resolveFor(ctx, args.task, hintsOf(args.folder, args.name));
    const projects = resolution.ranked.slice(0, TOP).map((p) => ({ folder: p.folder, name: nameOf(p.folder), score: p.score, why: p.why }));
    const low = isLowConfidence(resolution.confidence);
    const data = { projects, confidence: resolution.confidence, lowConfidence: low, advice: low ? NAME_THE_PROJECT : null };
    if (projects.length === 0) {
      return { data, summary: `AASC could not tell which project that task is about. ${NAME_THE_PROJECT}` };
    }
    const lines = projects.map((p, i) => `${i + 1}. ${p.name} (${p.folder}) · ${p.score} · ${p.why}`);
    return {
      data,
      summary: [`${resolution.confidence} confidence; best first:`, ...lines, ...(low ? [NAME_THE_PROJECT] : [])].join('\n'),
    };
  },
});

// ---------------------------------------------------------------------------
// task_route
// ---------------------------------------------------------------------------

/** A route's answer as a central reads it: the router's result, its one-line explanation, and the confidence ask. */
export function routeView(result: RouteResult) {
  const low = isLowConfidence(result.confidence);
  return {
    decision: result.decision,
    runnersUp: result.runnersUp,
    confidence: result.confidence,
    project: result.project,
    explanation: explain(result),
    lowConfidence: low,
    advice: low ? NAME_THE_PROJECT : null,
  };
}

/** The inputs both task_route and task_delegate to "auto" take besides the task. */
export const ROUTE_INPUTS = {
  cli: z.enum(['claude', 'codex']).optional().describe('Only reuse a session of this CLI, and open a new one with it.'),
  project: PROJECT_INPUT.optional(),
  model: z.string().min(1).max(100).optional().describe('The model a new session starts with (as the CLI takes it).'),
  newOnly: z.boolean().optional().describe('Always open a new session; never reuse one.'),
};

const taskRoute: ToolDef = defineTool({
  name: 'task_route',
  toolset: 'tasks',
  title: 'Where a task would go',
  description:
    'A dry run of task_delegate to "auto": says where AASC would send a task (reuse a session, open a new one in the ' +
    'project, or hand it down to a room or project central), the runners-up, the project and how sure AASC is of it, ' +
    'and why. It opens nothing and sends nothing, and it works even when auto routing is off in this AASC: pick from ' +
    'its answer and delegate by id. When confidence is low, name the project (project:) instead of trusting the guess.',
  risk: 'read',
  phase: 4,
  input: { task: TASK_INPUT, ...ROUTE_INPUTS },
  async run(args, ctx) {
    const result = await route(
      ctx,
      {
        task: args.task,
        ...(args.cli === undefined ? {} : { cli: args.cli }),
        ...(args.project === undefined ? {} : { project: args.project }),
        ...(args.model === undefined ? {} : { model: args.model }),
        ...(args.newOnly === undefined ? {} : { newOnly: args.newOnly }),
      },
      routeDepsFor(ctx),
    );
    const view = routeView(result);
    const tail = view.lowConfidence ? `\n${NAME_THE_PROJECT}` : '';
    return { data: view, summary: `Dry run, nothing opened or sent: AASC ${view.explanation}.${tail}` };
  },
});

export const routingTools: readonly ToolDef[] = [projectResolve, taskRoute];
