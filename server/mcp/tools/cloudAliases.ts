// tools/cloudAliases.ts — the cloud toolset's P6 alias and remote access writes (plan 2026-10-25, C3 Task 7):
// `cloud_aliases_preview` asks AASC what reconciling skill-note aliases would change, `cloud_aliases_reconcile` writes
// what that preview showed, and `remote_access_refresh` has AASC look again at Tailscale and what it told the account.
// Filed under `cloud` by cloudP6.ts.
//
// Each is a write: only a global central may call it (P6-4), within the call budget (P6-15). A preview changes no file,
// but the route keeps one alias review at a time, so it replaces any review open in the person's window (P6-3). A
// reconcile writes alias command files into ~/.claude and ~/.codex for every project, as resource_alias_add does; the
// route writes only what the preview it names showed, as the same account, and refuses (409) when anything moved since:
// INVALID, preview again. The alias routes read the `x-aasc-notes-*` headers; they name the live account
// (cloudWrite.ts `liveAccount`), because the preview is the review the route holds the reconcile to. An alias message is
// text the cloud or a person wrote: fenced as untrusted in `data`, and in the text only inside the one block of rows.
// Remote access needs no binding (it works with no cloud connection) and exists only in newer builds (P6-11).
//
// `remoteViewOf` comes from cloud.ts, which lists these tools (cloud.ts → cloudP6.ts → here): it is imported when a
// refresh runs, never at module load, so the cycle never meets a module still loading.

import { z } from 'zod';
import { NoteKeySchema } from '../../../src/types/skillNotesSync.js';
import type { ToolContext, ToolDef, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { CLOUD } from './cloudCall.js';
import { CLOUD_CALLS_PER_MINUTE, CLOUD_RULES, cloudSend, cloudWriteBody, liveAccount, spendCloudCall } from './cloudWrite.js';
import { defineTool, fence, isRecord, oneLine, plain, plural } from './define.js';
import { assertGlobal } from './resourceWrite.js';
import { fenced, records, str, strings } from './shape.js';

const KEYS_MAX = 100;
const CHANGES_MAX = 200;
const FILES_MAX = 4;
const FILE_MAX = 1_024;
const MESSAGE_MAX = 500;
const ROW_MESSAGE_MAX = 160;

const BUDGET_RULE = `At most ${CLOUD_CALLS_PER_MINUTE} cloud changes a minute (BUDGET).`;

const KEYS = z
  .array(NoteKeySchema)
  .min(1)
  .max(KEYS_MAX)
  .describe('Skill note keys, agent:name, as skillnote_list shows them (1 to 100; a repeated key counts once).');

const REVIEW_ID = z.uuid().describe('data.reviewId of your cloud_aliases_preview of the same keys.');

/** The keys once each, in the order given: the preview and the reconcile must send the very same list. */
const once = (keys: readonly string[]): string[] => [...new Set(keys)];

/** The checks before an alias write touches anything: global (an alias changes every project), then the budget. */
function aliasCall(ctx: ToolContext): void {
  assertGlobal(ctx);
  spendCloudCall(ctx);
}

/** An alias message, fenced as untrusted; null when there is none. */
const messageOf = (key: string, raw: unknown): string | null => {
  const message = str(raw) ?? '';
  return message === '' ? null : fenced(`cloud-alias:${key}`, 'alias-message', message, MESSAGE_MAX).value;
};

interface AliasStatusView {
  key: string;
  state: string;
  message: string | null;
}

/** Statuses as the route answered them: key, state (AASC's word), message fenced. */
function statusesOf(raw: unknown): { views: AliasStatusView[]; rows: string[] } {
  const found = records(raw).flatMap((s) => {
    const key = str(s.key);
    return key === null || key === '' ? [] : [{ key, state: plain(str(s.state) ?? '', 20), said: str(s.message) ?? '' }];
  });
  return {
    views: found.map((s) => ({ key: s.key, state: s.state, message: messageOf(s.key, s.said) })),
    rows: found.map((s) => `${s.key} · ${s.state}${s.said === '' ? '' : ` · ${oneLine(s.said, ROW_MESSAGE_MAX)}`}`),
  };
}

/** How many statuses are in each state. */
function countsOf(statuses: readonly AliasStatusView[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s.state] = (counts[s.state] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// cloud_aliases_preview
// ---------------------------------------------------------------------------

const cloudAliasesPreview = defineTool({
  name: 'cloud_aliases_preview',
  toolset: 'cloud',
  title: 'Preview skill note aliases',
  description:
    'Asks AASC what reconciling skill-note aliases (the short names that run a skill or command) for these keys would ' +
    'change: for each key the action (create, update, remove, retry) and the alias files it touches, and each key’s ' +
    'alias state, with messages fenced as untrusted data. It writes no alias file, but AASC keeps one alias review at ' +
    'a time, so it replaces any alias review the person has open in AASC (they would review again there). It answers ' +
    'data.reviewId: pass it, with the same keys, to cloud_aliases_reconcile to write what it showed. ' +
    `${CLOUD_RULES.global} ${BUDGET_RULE}`,
  risk: 'write',
  phase: 6,
  input: { keys: KEYS },
  async run(args, ctx): Promise<ToolResult> {
    aliasCall(ctx);
    const keys = once(args.keys);
    const binding = await liveAccount(ctx);
    const body = cloudWriteBody<unknown>(await cloudSend(ctx, 'post', `${CLOUD}/aliases/preview`, { keys }, binding, 'notes'));
    const preview = isRecord(body) ? body : {};
    const reviewId = str(preview.reviewId) ?? '';
    if (!z.uuid().safeParse(reviewId).success) {
      throw new ToolError('UPSTREAM', 'AASC answered with an alias preview of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');
    }
    const found = records(preview.changes)
      .slice(0, CHANGES_MAX)
      .flatMap((c) => {
        const key = str(c.key);
        if (key === null || key === '') return [];
        const files = strings(c.files)
          .slice(0, FILES_MAX)
          .map((f) => f.slice(0, FILE_MAX));
        return [{ key, action: plain(str(c.action) ?? '', 20), files, said: str(c.message) ?? '' }];
      });
    const changes = found.map((c) => ({ key: c.key, action: c.action, files: c.files, message: messageOf(c.key, c.said) }));
    const statuses = statusesOf(preview.statuses);
    const data = {
      reviewId,
      enabled: preview.enabled === true,
      cached: preview.cached === true,
      changes,
      statuses: statuses.views,
      next: 'cloud_aliases_reconcile',
    };
    const rows = [
      ...found.map((c) => `${c.key} · ${c.action} · ${c.files.length === 0 ? 'no files' : c.files.join(', ')}${c.said === '' ? '' : ` · ${oneLine(c.said, ROW_MESSAGE_MAX)}`}`),
      ...statuses.rows.map((r) => `now: ${r}`),
    ];
    const lead =
      `Alias preview ${reviewId}: ${changes.length === 0 ? 'nothing to change' : plural(changes.length, 'change')} for ` +
      `${plural(keys.length, 'skill')}; aliases are ${data.enabled ? 'on' : 'off'} for this Mac` +
      `${data.cached ? ' (from the saved copy: the cloud was not reachable)' : ''}. To write it, call cloud_aliases_reconcile ` +
      'with this reviewId and the same keys.';
    return {
      data,
      summary: rows.length === 0 ? lead : `${lead}\n${fence('aasc', 'cloud-alias-preview', rows.join('\n'))}`,
      activity: [{ summary: `Previewed aliases: ${plural(changes.length, 'change')}`, detail: { reviewId, keys: keys.length, changes: changes.length } }],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_aliases_reconcile
// ---------------------------------------------------------------------------

const cloudAliasesReconcile = defineTool({
  name: 'cloud_aliases_reconcile',
  toolset: 'cloud',
  title: 'Write skill note aliases',
  description:
    'Writes the aliases your cloud_aliases_preview showed: alias command files into ~/.claude and ~/.codex for every ' +
    'project, as resource_alias_add does. Pass that preview’s data.reviewId and the same keys you passed it. If anything ' +
    'changed since that preview (a note, an alias file, the account, another preview, the person’s own review) it is ' +
    'INVALID: preview again. Answers each key’s alias state (installed, disabled, needs-resource, conflict, ' +
    `unsupported), messages fenced as untrusted data. ${CLOUD_RULES.global} ${BUDGET_RULE}`,
  risk: 'write',
  phase: 6,
  input: { keys: KEYS, reviewId: REVIEW_ID },
  async run(args, ctx): Promise<ToolResult> {
    aliasCall(ctx);
    const keys = once(args.keys);
    const binding = await liveAccount(ctx);
    const sent = await cloudSend(ctx, 'post', `${CLOUD}/aliases/reconcile`, { keys, reviewId: args.reviewId }, binding, 'notes');
    if (sent.status === 409) {
      throw new ToolError(
        'INVALID',
        'That review is out of date: preview again.',
        'Call cloud_aliases_preview with the same keys, then cloud_aliases_reconcile with its new reviewId.',
      );
    }
    const statuses = statusesOf(cloudWriteBody<unknown>(sent));
    const counts = countsOf(statuses.views);
    const tally = Object.entries(counts)
      .map(([state, n]) => `${n} ${state}`)
      .join(', ');
    const lead = `Reconciled the aliases of ${plural(keys.length, 'skill')}${tally === '' ? '' : `: ${tally}`}.`;
    return {
      data: { statuses: statuses.views },
      summary: statuses.rows.length === 0 ? lead : `${lead}\n${fence('aasc', 'cloud-aliases', statuses.rows.join('\n'))}`,
      activity: [{ summary: `Reconciled aliases of ${plural(keys.length, 'skill')}`, detail: { keys: keys.length, ...counts } }],
    };
  },
});

// ---------------------------------------------------------------------------
// remote_access_refresh
// ---------------------------------------------------------------------------

interface RemoteData {
  tailscale: { state: string };
  publish: { state: string };
  phones: readonly unknown[];
}

const remoteAccessRefresh = defineTool({
  name: 'remote_access_refresh',
  toolset: 'cloud',
  title: 'Refresh remote access',
  description:
    'Has AASC look again at remote access: a fresh Tailscale status, then its check of what this Mac has told its AASC ' +
    'Cloud account about where to find it. It may tell the account the Mac’s Tailscale address, as AASC itself does ' +
    'every minute. Answers the view remote_access_get gives (phone device ids left out). ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.newer} ${BUDGET_RULE}`,
  risk: 'write',
  phase: 6,
  input: {},
  async run(_args, ctx): Promise<ToolResult> {
    assertGlobal(ctx, 'changes what this Mac tells AASC Cloud', 'remote access belongs to the whole Mac');
    spendCloudCall(ctx);
    const sent = await ctx.client.post(`${CLOUD}/remote-access/refresh`, {}, { signal: ctx.signal });
    const body = cloudWriteBody<unknown>(sent, {
      what: 'This build of AASC cannot refresh remote access.',
      hint: 'cloud_status shows the cloud connection; the person can look in RESOURCES → Cloud → Remote access.',
    });
    // At run time only: cloud.ts lists this module (see the head of this file).
    const { remoteViewOf } = await import('./cloud.js');
    const view = remoteViewOf(body);
    const seen = view.data as RemoteData;
    return {
      data: view.data,
      summary: `AASC looked again at remote access. ${view.summary}`,
      activity: [
        {
          summary: `Refreshed remote access: Tailscale ${seen.tailscale.state || 'unknown'}, sharing ${seen.publish.state || 'unknown'}`,
          detail: { tailscale: seen.tailscale.state, publish: seen.publish.state, phones: seen.phones.length },
        },
      ],
    };
  },
});

export const cloudAliasTools: readonly ToolDef[] = [cloudAliasesPreview, cloudAliasesReconcile, remoteAccessRefresh];
