// tools/system.ts — the system toolset, P1: how AASC and the Mac are doing, and what the central itself is.
// Read only. This module holds the status reads (presence, plan limits, health); the install and Mac reads are
// in host.ts, the two tools about centrals in central.ts, and P3's `confirm_wait` and `aasc_set_keep_awake` in
// systemWrite.ts. All four are filed under `system`.
//
// Scope: none of these is about one session. `aasc_plan_usage` reads every session's plan report because the
// limits belong to the account, not to a session, and it names no session in its answer. The others read
// routes that describe AASC, not a session.

import { z } from 'zod';
import type { PlanCli, PlanUsage } from '../../../src/types/session.js';
import type { ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { centralTools } from './central.js';
import { defineTool, fence, isRecord, nonEmptyString, oneLine, plural, unwrap } from './define.js';
import { hostTools } from './host.js';
import { systemWriteTools } from './systemWrite.js';
import { ago, span } from './views.js';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ---------------------------------------------------------------------------
// aasc_presence
// ---------------------------------------------------------------------------

interface DeviceView {
  label: string;
  isLocal: boolean;
  connections: number;
  connectedAt: number;
  lastSeenAt: number;
  /** The device AASC lets save the workspace now (the route's `workspaceWriter`). */
  savesWorkspace: boolean;
}

/** Why the Mac's window is not the one saving the workspace, in a few words. */
function closedBecause(devices: readonly DeviceView[], writer: DeviceView | undefined): string {
  if (devices.length === 0) return 'no device is connected';
  return writer === undefined ? 'no connected device saves the workspace' : 'a remote device saves the workspace';
}

/**
 * GET /presence's snapshot (unwrapped) as the presence tool reads it. The route elects the device that saves the
 * workspace: a local one over a remote one, then the oldest connection. "The Mac's window is open" means that device is
 * the Mac's and is connected, so it follows the route's own pick.
 */
function presenceOf(snapshot: unknown): { devices: DeviceView[]; writer: DeviceView | undefined; macWindowOpen: boolean } {
  const raw = isRecord(snapshot) ? snapshot : {};
  const writerId = nonEmptyString(raw.workspaceWriter);
  const devices: DeviceView[] = (Array.isArray(raw.devices) ? raw.devices : []).filter(isRecord).map((d) => ({
    label: typeof d.label === 'string' ? d.label : '',
    isLocal: d.isLocal === true,
    connections: num(d.connections),
    connectedAt: num(d.connectedAt),
    lastSeenAt: num(d.lastSeenAt),
    savesWorkspace: writerId !== null && d.clientId === writerId,
  }));
  const writer = devices.find((d) => d.savesWorkspace && d.connections > 0);
  return { devices, writer, macWindowOpen: writer?.isLocal === true };
}

/**
 * Is the Mac's own AASC window open, by GET /presence's snapshot (unwrapped)? What `aasc_presence` answers as
 * `macWindowOpen`, and what runTool's confirmation gate asks before it opens a card nobody could answer.
 */
export const macWindowOpenOf = (raw: unknown): boolean => presenceOf(raw).macWindowOpen;

const aascPresence = defineTool({
  name: 'aasc_presence',
  toolset: 'system',
  title: 'Devices connected to AASC',
  description:
    'Says which devices are connected to AASC (this Mac’s window, a phone, a browser), which one saves the ' +
    'workspace, and whether the Mac’s own window is open: that is, whether the device that saves the workspace ' +
    '(what AASC restores after a restart, rooms included) is the Mac itself. Device names are text a device set ' +
    'itself, fenced as untrusted.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const { devices, writer, macWindowOpen } = presenceOf(unwrap<unknown>(await ctx.client.get('/presence')));
    const data = { macWindowOpen, deviceCount: devices.length, devices };
    const lead = macWindowOpen ? 'The Mac’s window is open: it saves the workspace.' : `The Mac’s window is closed: ${closedBecause(devices, writer)}.`;
    if (devices.length === 0) return { data, summary: lead };
    const now = ctx.now();
    const rows = devices.map(
      (d) => `${JSON.stringify(oneLine(d.label, 60))} · ${d.isLocal ? 'on this Mac' : 'remote'} · ${plural(d.connections, 'connection')} · seen ${ago(now - d.lastSeenAt)}${d.savesWorkspace ? ' · saves the workspace' : ''}`,
    );
    return { data, summary: `${lead} ${plural(devices.length, 'device')} connected:\n${fence('aasc', 'devices', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// aasc_plan_usage and aasc_plan_usage_refresh
// ---------------------------------------------------------------------------

const CLIS: readonly PlanCli[] = ['claude', 'codex'];
const CLI_NAME: Record<PlanCli, string> = { claude: 'Claude', codex: 'Codex' };

/** `5-hour` and `weekly` as the CLIs' own screens call them; any other length by its length. */
function windowLabel(minutes: number): string {
  if (minutes === 300) return '5-hour';
  if (minutes === 10_080) return 'weekly';
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/** A plan name the CLI reports (`plus`, `max`): kept only when it is a plain word, since it is text from outside. */
const safePlan = (plan: unknown): string | null => (typeof plan === 'string' && /^[A-Za-z0-9 _.-]{1,40}$/.test(plan) ? plan : null);

interface PlanView {
  plan: string | null;
  limitReached: boolean;
  asOf: number;
  windows: Array<{ label: string; minutes: number; usedPercent: number; resetsAt: number | null }>;
}

function planView(usage: PlanUsage): PlanView {
  return {
    plan: safePlan(usage.plan),
    limitReached: usage.limitReached === true,
    asOf: usage.asOf,
    windows: usage.windows.map((w) => ({ label: windowLabel(w.minutes), minutes: w.minutes, usedPercent: w.usedPercent, resetsAt: w.resetsAt })),
  };
}

function planLine(cli: PlanCli, view: PlanView | null, now: number): string {
  if (view === null) return `${CLI_NAME[cli]}: no report yet.`;
  const windows = view.windows.map((w) => {
    const reset = w.resetsAt === null ? '' : w.resetsAt > now ? ` (resets in ${span(w.resetsAt - now)})` : ' (reset time has passed)';
    return `${w.label} ${Math.round(w.usedPercent)}% used${reset}`;
  });
  const name = view.plan === null ? CLI_NAME[cli] : `${CLI_NAME[cli]} (${view.plan})`;
  const reached = view.limitReached ? ' LIMIT REACHED.' : '';
  return `${name}: ${windows.join(', ')}, as of ${ago(now - view.asOf)}.${reached}`;
}

const aascPlanUsage = defineTool({
  name: 'aasc_plan_usage',
  toolset: 'system',
  title: 'Plan limits',
  description:
    'Shows how much of each CLI’s 5-hour and weekly plan limits is used, and when they reset. The limits belong ' +
    'to the account, not to a session: every session of a CLI reports the same numbers, so this is the freshest ' +
    'report any of them carries. null for a CLI that has not reported yet.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    // Every session on purpose: the limits are account-wide, and the answer names no session.
    const reports = ctx.sessions().flatMap((s) => (s.planUsage ? [s.planUsage] : []));
    const views = Object.fromEntries(
      CLIS.map((cli) => {
        const newest = reports.filter((u) => u.cli === cli).sort((a, b) => b.asOf - a.asOf)[0];
        return [cli, newest === undefined ? null : planView(newest)];
      }),
    ) as Record<PlanCli, PlanView | null>;
    const now = ctx.now();
    return { data: views, summary: CLIS.map((cli) => planLine(cli, views[cli], now)).join('\n') };
  },
});

interface SyncResult {
  cli: string;
  checkedAt: number;
  asOf: number | null;
  changed: boolean;
}

const aascPlanUsageRefresh = defineTool({
  name: 'aasc_plan_usage_refresh',
  toolset: 'system',
  title: 'Re-read the plan limits',
  description:
    'Asks AASC to re-read a CLI’s plan limits now (both when none is named). The new numbers reach ' +
    'aasc_plan_usage with the next session update, a moment later. Rate-limited: do not call it in a loop.',
  risk: 'read',
  phase: 1,
  input: { cli: z.enum(['claude', 'codex']).optional().describe('Which CLI to re-read; both when left out.') },
  async run(args, ctx) {
    const asked = args.cli === undefined ? CLIS : [args.cli];
    const results: SyncResult[] = [];
    const failed: Array<{ cli: string; error: string }> = [];
    let first: ToolError | null = null;
    for (const cli of asked) {
      try {
        const body = unwrap<Record<string, unknown>>(await ctx.client.post('/plan-usage/sync', { cli }));
        results.push({ cli, checkedAt: num(body.checkedAt), asOf: typeof body.asOf === 'number' ? body.asOf : null, changed: body.changed === true });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        first ??= err;
        failed.push({ cli, error: err.message });
      }
    }
    if (results.length === 0 && first !== null) throw first;
    const said = results.map((r) => `${r.cli} ${r.changed ? 'has new numbers' : 'unchanged'}`);
    const trouble = failed.map((f) => `${f.cli} failed: ${f.error}`);
    return {
      data: { results, failed },
      summary: `Re-read the plan limits: ${[...said, ...trouble].join('; ')}. Call aasc_plan_usage in a moment to read the numbers.`,
    };
  },
});

// ---------------------------------------------------------------------------
// aasc_health
// ---------------------------------------------------------------------------

const HEALTH_ROUTES = ['/health-check', '/hooks/status', '/mq-stats', '/hook-stats'] as const;

function hooksView(body: unknown) {
  if (!isRecord(body)) return null;
  const clis: Record<string, { installed: boolean; density: string; events: number }> = {};
  for (const [name, raw] of Object.entries(isRecord(body.clis) ? body.clis : {})) {
    if (!isRecord(raw)) continue;
    clis[name] = { installed: raw.installed === true, density: nonEmptyString(raw.density) ?? 'off', events: Array.isArray(raw.events) ? raw.events.length : 0 };
  }
  const enabled = Array.isArray(body.enabledClis) ? body.enabledClis.filter((c): c is string => typeof c === 'string') : [];
  return { installed: body.installed === true, density: nonEmptyString(body.density) ?? 'off', enabledClis: enabled, clis };
}

function queueView(body: unknown) {
  if (!isRecord(body)) return null;
  return {
    running: body.running === true,
    linesProcessed: num(body.linesProcessed),
    linesErrored: num(body.linesErrored),
    truncations: num(body.truncations),
    lastProcessedAt: typeof body.lastProcessedAt === 'number' ? body.lastProcessedAt : null,
  };
}

function statsView(body: unknown) {
  if (!isRecord(body)) return null;
  const events = Object.entries(isRecord(body.events) ? body.events : {}).flatMap(([type, raw]) => {
    if (!isRecord(raw)) return [];
    const latency = isRecord(raw.latency) ? raw.latency : {};
    const processing = isRecord(raw.processing) ? raw.processing : {};
    return [{ type, count: num(raw.count), ratePerMin: num(raw.rate), avgLatencyMs: num(latency.avg), avgProcessingMs: num(processing.avg) }];
  });
  return { totalHooks: num(body.totalHooks), hooksPerMin: num(body.hooksPerMin), events };
}

const aascHealth = defineTool({
  name: 'aasc_health',
  toolset: 'system',
  title: 'AASC health',
  description:
    'Checks AASC itself: whether the server is up and for how long, whether the hooks that report each CLI’s ' +
    'activity are installed (and at what density), whether the hook queue is running without errors, and how ' +
    'many hooks arrive per minute. A part that cannot be read is reported, the rest still answered.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const answers = await Promise.all(HEALTH_ROUTES.map((route) => ctx.client.get<unknown>(route)));
    if (answers.every((a) => !a.ok)) unwrap(answers[0]);
    const part = <T>(name: string, i: number, build: (body: unknown) => T | null): { value: T | null; problem: string | null } => {
      try {
        return { value: build(unwrap<unknown>(answers[i])), problem: null };
      } catch (err) {
        if (err instanceof ToolError) return { value: null, problem: `${name}: ${err.message}` };
        throw err;
      }
    };
    const health = isRecord(answers[0].data) ? answers[0].data : {};
    const hooks = part('hooks', 1, hooksView);
    const queue = part('queue', 2, queueView);
    const stats = part('hook stats', 3, statsView);
    const problems = [hooks, queue, stats].flatMap((p) => (p.problem === null ? [] : [p.problem]));
    if (!answers[0].ok) problems.unshift(`server: ${answers[0].error ?? `HTTP ${answers[0].status}`}`);
    const uptimeSeconds = typeof health.uptime === 'number' ? Math.round(health.uptime) : null;
    const data = { status: nonEmptyString(health.status) ?? (answers[0].ok ? 'ok' : 'unknown'), uptimeSeconds, hooks: hooks.value, queue: queue.value, hookStats: stats.value, problems };
    const lines = [`AASC is ${answers[0].ok ? 'up' : 'not answering'}${uptimeSeconds === null ? '' : ` (${span(uptimeSeconds * 1_000)})`}.`];
    if (hooks.value !== null) {
      const clis = Object.entries(hooks.value.clis).map(([name, c]) => (c.installed ? `${name} (${c.density})` : `${name} not installed`));
      lines.push(`Hooks: ${clis.length === 0 ? 'none installed' : clis.join(', ')}.`);
    }
    if (queue.value !== null) {
      lines.push(`Hook queue: ${queue.value.running ? 'running' : 'NOT running'}, ${plural(queue.value.linesProcessed, 'hook')} processed, ${plural(queue.value.linesErrored, 'error')}.`);
    }
    if (stats.value !== null) lines.push(`${stats.value.hooksPerMin} hooks/min, ${stats.value.totalHooks} since start.`);
    if (problems.length > 0) lines.push(`Problems: ${problems.join('; ')}.`);
    return { data, summary: lines.join('\n') };
  },
});

export const systemTools: readonly ToolDef[] = [
  aascPresence,
  aascPlanUsage,
  aascPlanUsageRefresh,
  aascHealth,
  ...hostTools,
  ...centralTools,
  ...systemWriteTools,
];
