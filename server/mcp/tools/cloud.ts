// tools/cloud.ts — the cloud toolset, P1, the connection and the account's sync: where this Mac stands with AASC
// Cloud, whether skill notes can sync, the sync list, the state of skill-note aliases, and remote access (Tailscale
// and the paired phones). The account's resources and projects are in cloudProjects.ts. Read only. Syncing,
// publishing, installing and the rest are P6 (cloudP6.ts), listed at the end of `cloudTools`; `remoteViewOf` is shared
// with P6's remote_access_refresh.
//
// The cloud belongs to the Mac, not to a session: every central that has the toolset may read it, whatever its
// scope, and the toolset is off for a Codex central unless the person turns it on. How a tool names the account it
// asks as, and how a failure is worded, is cloudCall.ts. Text the cloud or a person wrote (an error, a reason a
// resource cannot sync, an alias message) is fenced as untrusted in `data`; names, ids, states, versions and
// counts stay plain, and the rows in the text sit in one block. Two routes exist only in newer builds of AASC
// (the sync list, remote access): there the tool answers UNAVAILABLE.

import { z } from 'zod';
import { NoteKeySchema } from '../../../src/types/skillNotesSync.js';
import type { ToolDef, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { boundGet, boundTo, bindingHeaders, CLOUD, cloudBody, cloudStatus, type CloudState } from './cloudCall.js';
import { cloudP6Tools } from './cloudP6.js';
import { cloudProjectTools } from './cloudProjects.js';
import { defineTool, fence, isRecord, nonEmptyString, oneLine, plain, plural, unwrap } from './define.js';
import { CURSOR_INPUT, fenced, limitInput, num, pageOf, pageWords, records, routeMissing, str, whole } from './shape.js';

// ---------------------------------------------------------------------------
// cloud_status and cloud_notes_status
// ---------------------------------------------------------------------------

const STATE_WORDS: Readonly<Record<CloudState, string>> = {
  connected: 'AASC Cloud is connected.',
  disconnected: 'This Mac is not connected to AASC Cloud.',
  offline: 'This Mac is signed in to AASC Cloud, but the backend is not answering (offline).',
  revoked: 'AASC Cloud no longer accepts this Mac (revoked): it has to be reconnected.',
  unknown: 'AASC Cloud is in a state this build does not know.',
};

const cloudStatusTool = defineTool({
  name: 'cloud_status',
  toolset: 'cloud',
  title: 'AASC Cloud connection',
  description:
    'Says where this Mac stands with AASC Cloud: connected, offline, revoked or not connected, and for a connection the ' +
    'backend, the account and device, the generation and the last error (fenced as untrusted data).',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const status = await cloudStatus(ctx);
    const { connection } = status;
    const data = {
      state: status.state,
      connected: status.state === 'connected' && connection !== null,
      connection,
      lastError: status.lastError === null ? null : fenced('aasc', 'cloud-error', status.lastError, 500).value,
    };
    const rows = [
      ...(connection === null
        ? []
        : [
            `backend ${connection.backendOrigin}`,
            `device ${JSON.stringify(connection.deviceName ?? '')}`,
            `account ${connection.accountId}`,
            ...(connection.accountEmail === null ? [] : [`email ${connection.accountEmail}`]),
            `generation ${connection.generation}`,
          ]),
      ...(status.lastError === null ? [] : [`last error: ${oneLine(status.lastError, 200)}`]),
    ];
    const words = STATE_WORDS[status.state];
    return { data, summary: rows.length === 0 ? words : `${words}\n${fence('aasc', 'cloud', rows.join('\n'))}` };
  },
});

const cloudNotesStatus = defineTool({
  name: 'cloud_notes_status',
  toolset: 'cloud',
  title: 'Skill notes sync status',
  description: 'Says whether skill notes can sync through AASC Cloud and, if so, as which account (backend, account id and generation).',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const body = cloudBody<unknown>(await ctx.client.get(`${CLOUD}/skill-notes/status`));
    const answer = isRecord(body) ? body : {};
    const c = isRecord(answer.connection) ? answer.connection : null;
    const backendOrigin = c === null ? null : str(c.backendOrigin);
    const accountId = c === null ? null : str(c.accountId);
    const generation = c === null ? null : num(c.generation);
    const connection = backendOrigin && accountId && generation !== null ? { backendOrigin, accountId, generation } : null;
    const state = str(answer.state) ?? 'disconnected';
    const data = { state: plain(state, 20), connected: state === 'connected' && connection !== null, connection };
    if (connection === null) return { data, summary: 'Skill notes cannot sync: this Mac is not connected to AASC Cloud.' };
    return {
      data,
      summary: `Skill notes sync through AASC Cloud (${plain(state, 20)}).\n${fence('aasc', 'cloud', `backend ${connection.backendOrigin}\naccount ${connection.accountId}\ngeneration ${connection.generation}`)}`,
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_sync_status
// ---------------------------------------------------------------------------

/** The states of a resource in the sync list (SYNC_STATES in the checkout whose build has the route). */
const SYNC_STATES = ['synced', 'local-changed', 'cloud-newer', 'cloud-only', 'conflict', 'blocked', 'stopped', 'removed'] as const;
const SYNC_DEFAULT = 100;
const SYNC_MAX = 200;
const REASON_MAX = 500;

interface SyncRow {
  resourceId: string;
  catalogId: string | null;
  name: string;
  agent: string;
  kind: string;
  scope: string;
  state: string;
  cloudVersion: number | null;
  syncedVersion: number | null;
  memory: boolean;
  reason: string;
}

function syncRowOf(raw: Record<string, unknown>): SyncRow | null {
  const resourceId = str(raw.resourceId);
  if (resourceId === null || resourceId === '') return null;
  const catalogId = str(raw.catalogId);
  return {
    resourceId,
    catalogId: catalogId === null || catalogId === '' ? null : catalogId,
    name: str(raw.name) ?? '',
    agent: str(raw.agent) ?? '',
    kind: str(raw.kind) ?? '',
    scope: str(raw.scope) ?? '',
    state: plain(str(raw.state) ?? '', 20),
    cloudVersion: num(raw.cloudVersion),
    syncedVersion: num(raw.syncedVersion),
    memory: raw.memory === true,
    reason: str(raw.reason) ?? '',
  };
}

const cloudSyncStatus = defineTool({
  name: 'cloud_sync_status',
  toolset: 'cloud',
  title: 'Cloud sync list',
  description:
    'Lists the account’s resources as one sync list: for each its name, agent, kind, scope, state (synced, ' +
    'local-changed, cloud-newer, cloud-only, conflict, blocked, stopped, removed), the cloud’s version and the version ' +
    'this Mac last synced, with how many of each state and how many Sync now would move. Filter by state. 100 to ' +
    'a page, up to 200; pass nextCursor back as cursor. A reason a resource cannot sync is fenced as untrusted data. ' +
    'Only newer builds of AASC have this list.',
  risk: 'read',
  phase: 1,
  input: {
    state: z.enum(SYNC_STATES).optional().describe('Only resources in this state.'),
    cursor: CURSOR_INPUT,
    limit: limitInput(SYNC_MAX, SYNC_DEFAULT),
  },
  async run(args, ctx) {
    const answer = await boundGet(ctx, `${CLOUD}/sync-status`);
    if (routeMissing(answer)) {
      throw new ToolError('UNAVAILABLE', 'This build of AASC has no cloud sync list.', 'cloud_resource_list lists what the account holds.');
    }
    const body = cloudBody<unknown>(answer);
    const list = isRecord(body) ? body : {};
    const all = records(list.items).flatMap((raw) => {
      const row = syncRowOf(raw);
      return row === null ? [] : [row];
    });
    const counts: Record<string, number> = {};
    for (const row of all) counts[row.state] = (counts[row.state] ?? 0) + 1;
    const found = args.state === undefined ? all : all.filter((r) => r.state === args.state);
    const page = pageOf(found.length, args.cursor, args.limit ?? SYNC_DEFAULT);
    const shown = found.slice(page.start, page.end);
    const waiting = whole(list.waiting);
    const data = {
      waiting,
      total: all.length,
      counts,
      count: found.length,
      start: page.start,
      shown: shown.length,
      nextCursor: page.next,
      items: shown.map((r) => ({
        resourceId: r.resourceId,
        catalogId: r.catalogId,
        name: r.name,
        agent: r.agent,
        kind: r.kind,
        scope: r.scope,
        state: r.state,
        cloudVersion: r.cloudVersion,
        syncedVersion: r.syncedVersion,
        memory: r.memory,
        reason: r.reason === '' ? null : fenced(`cloud-resource:${r.resourceId}`, 'sync-reason', r.reason, REASON_MAX).value,
      })),
    };
    if (all.length === 0) return { data, summary: 'The sync list is empty: the account holds no resources and none was synced from this Mac.' };
    const tally = Object.entries(counts).map(([state, n]) => `${n} ${state}`).join(', ');
    const lead = `${plural(all.length, 'resource')} in the sync list (${tally}); Sync now would move ${waiting}`;
    if (shown.length === 0) return { data, summary: `${lead}. None is in the state or page asked for.` };
    const { range, more } = pageWords(page, found.length);
    const rows = shown.map((r) =>
      [
        r.state,
        `${r.agent} ${r.kind}`,
        r.name,
        `synced v${r.syncedVersion ?? '–'} of v${r.cloudVersion ?? '–'}`,
        r.memory ? 'memory' : null,
        r.reason === '' ? null : `reason: ${oneLine(r.reason, 160)}`,
      ]
        .filter((p): p is string => p !== null)
        .join(' · '),
    );
    return { data, summary: `${lead}${range}.${more}\n${fence('aasc', 'cloud-sync', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// cloud_aliases_status
// ---------------------------------------------------------------------------

const KEYS_MAX = 100;
const ALIAS_MESSAGE_MAX = 500;

const cloudAliasesStatus = defineTool({
  name: 'cloud_aliases_status',
  toolset: 'cloud',
  title: 'Skill note alias status',
  description:
    'Says whether skill-note aliases (the short names that run a skill or command) are on for this Mac, and the state of ' +
    'each: installed, disabled, needs-resource, conflict or unsupported, with a message where there is one (fenced as ' +
    'untrusted data). Pass keys (agent:name) to ask about particular skills; without them it asks about every ' +
    'skill note that has an abbreviation (up to 100). Changes nothing.',
  risk: 'read',
  phase: 1,
  input: {
    keys: z
      .array(NoteKeySchema)
      .min(1)
      .max(KEYS_MAX)
      .optional()
      .describe('Skill note keys, agent:name, as skillnote_list shows them (1 to 100).'),
  },
  async run(args, ctx) {
    const binding = await boundTo(ctx);
    let keys = args.keys === undefined ? undefined : [...new Set(args.keys)];
    if (keys === undefined) {
      const body = unwrap<unknown>(await ctx.client.get('/skill-notes/favorites'));
      const entries = records(isRecord(body) ? body.entries : []);
      keys = entries
        .filter((e) => typeof e.abbr === 'string' && e.abbr !== '')
        .map((e) => str(e.key) ?? '')
        .filter((key) => NoteKeySchema.safeParse(key).success)
        .slice(0, KEYS_MAX);
    }
    if (keys.length === 0) {
      return {
        data: { enabled: false, cached: false, connected: true, keys: 0, counts: {}, statuses: [] },
        summary: 'No skill note has an abbreviation, so there are no aliases to report.',
      };
    }
    const body = cloudBody<unknown>(await ctx.client.post(`${CLOUD}/aliases/status`, { keys }, { headers: bindingHeaders(binding, 'notes') }));
    const device = isRecord(body) ? body : {};
    const statuses = records(device.statuses).flatMap((raw) => {
      const key = str(raw.key);
      return key === null || key === '' ? [] : [{ key, state: plain(str(raw.state) ?? '', 20), message: str(raw.message) ?? '' }];
    });
    const counts: Record<string, number> = {};
    for (const s of statuses) counts[s.state] = (counts[s.state] ?? 0) + 1;
    const data = {
      enabled: device.enabled === true,
      cached: device.cached === true,
      connected: isRecord(device.connection),
      keys: keys.length,
      counts,
      statuses: statuses.map((s) => ({
        key: s.key,
        state: s.state,
        message: s.message === '' ? null : fenced(`cloud-alias:${s.key}`, 'alias-message', s.message, ALIAS_MESSAGE_MAX).value,
      })),
    };
    const lead =
      `Aliases are ${data.enabled ? 'on' : 'off'} for this Mac; ${plural(statuses.length, 'skill')} reported` +
      `${data.cached ? ' from the saved copy (the cloud was not reachable)' : ''}.`;
    if (statuses.length === 0) return { data, summary: lead };
    const rows = statuses.map((s) => `${s.key} · ${s.state}${s.message === '' ? '' : ` · ${oneLine(s.message, 160)}`}`);
    return { data, summary: `${lead}\n${fence('aasc', 'cloud-aliases', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// remote_access_get
// ---------------------------------------------------------------------------

const remoteAccessGet = defineTool({
  name: 'remote_access_get',
  toolset: 'cloud',
  title: 'Remote access',
  description:
    'Describes how a paired phone reaches this Mac away from home: whether Tailscale is installed and connected (its ' +
    'address, account, tailnet), whether this Mac has told its AASC Cloud account where to find it, and for each paired ' +
    'phone whether it has the Mac’s Tailscale address and how it last connected. Phone device ids are left out. ' +
    'Only newer builds of AASC have this page.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const answer = await ctx.client.get(`${CLOUD}/remote-access`);
    if (routeMissing(answer)) {
      throw new ToolError('UNAVAILABLE', 'This build of AASC has no remote access page.', 'cloud_status shows the cloud connection.');
    }
    return remoteViewOf(cloudBody<unknown>(answer));
  },
});

/**
 * The remote access view as remote_access_get answers it, from the route's data: phone device ids left out. Shared with
 * P6's remote_access_refresh, which answers the same view.
 */
export function remoteViewOf(body: unknown): ToolResult {
  const view = isRecord(body) ? body : {};
  const ts = isRecord(view.tailscale) ? view.tailscale : {};
  const pub = isRecord(view.publish) ? view.publish : {};
  const tailscale = {
    state: plain(str(ts.state) ?? '', 30),
    address: nonEmptyString(ts.address),
    account: nonEmptyString(ts.account),
    tailnet: nonEmptyString(ts.tailnet),
    dnsName: nonEmptyString(ts.dnsName),
    canOpenApp: ts.canOpenApp === true,
  };
  const publish = { state: plain(str(pub.state) ?? '', 30), tailnet: nonEmptyString(pub.tailnet), port: whole(pub.port), at: num(pub.at) };
  const phones = records(view.phones).map((p) => ({
    label: str(p.label) ?? '',
    platform: str(p.platform) === 'ios' || str(p.platform) === 'android' ? (p.platform as string) : '',
    status: plain(str(p.status) ?? '', 20),
    hasTailnet: p.hasTailnet === true,
    tailnetSentAt: num(p.tailnetSentAt),
    lastPath: str(p.lastPath) === 'lan' || str(p.lastPath) === 'tailnet' ? (p.lastPath as string) : null,
    lastPathAt: num(p.lastPathAt),
  }));
  const data = { tailscale, publish, port: whole(view.port), phones };
  const rows = [
    `tailscale ${tailscale.address ?? 'no address'}${tailscale.account === null ? '' : ` · ${tailscale.account}`}${tailscale.tailnet === null ? '' : ` · ${tailscale.tailnet}`}`,
    `shared with the cloud: ${publish.tailnet ?? 'nothing'} on port ${publish.port}`,
    ...phones.map((p) => `${JSON.stringify(p.label)} · ${p.platform} · ${p.status} · ${p.hasTailnet ? 'has the Tailscale address' : 'no Tailscale address'} · last ${p.lastPath ?? 'never connected'}`),
  ];
  const lead =
    `Remote access: Tailscale ${tailscale.state || 'unknown'}, sharing with the cloud ${publish.state || 'unknown'}; ` +
    `${phones.length === 0 ? 'no paired phones' : plural(phones.length, 'paired phone')}.`;
  return { data, summary: `${lead}\n${fence('aasc', 'remote-access', rows.join('\n'))}` };
}

/**
 * The catalog's order: connection, sync list, the account's resources and projects, then notes, aliases and remote
 * access; the P6 writes (cloudP6.ts) last.
 */
export const cloudTools: readonly ToolDef[] = [
  cloudStatusTool,
  cloudSyncStatus,
  ...cloudProjectTools,
  cloudNotesStatus,
  cloudAliasesStatus,
  remoteAccessGet,
  ...cloudP6Tools,
];
