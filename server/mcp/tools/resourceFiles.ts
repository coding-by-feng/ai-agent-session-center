// tools/resourceFiles.ts — the resources toolset, P1, the file-level reads: one file of a resource's package, how a
// resource differs from its repository copy, and how often skills and commands were used. Read only. (The list and
// the detail are in resources.ts.)
//
// What a file says is text anyone who wrote a skill or a plugin could have written: the content and the diff are
// fenced as untrusted in `data` and in the text. Secrets are masked by the server before it answers; these tools
// pass that through and add no masking of their own. Like the rest of the Library, these belong to the Mac, not to a
// session: every central that has the toolset may read them.

import { z } from 'zod';
import type { ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { clipText, defineTool, fence, isRecord, plural, seg, unwrap } from './define.js';
import { fenced, records, routeMissing, str, strings, whole } from './shape.js';

/** A Library id: 16 hex characters. */
export const HEX16 = /^[a-f0-9]{16}$/;
export const RESOURCE_ID = z
  .string()
  .regex(HEX16)
  .describe('A resource id as resource_list shows it (16 hex characters).');

/** The most characters of a file or a body handed over; the server's own cap is 512 KB. */
export const FILE_MAX = 100_000;
const PATCH_MAX = 20_000;
const USAGE_SHOWN = 100;

/** The source of a fence around text a resource's file wrote. */
export const sourceOf = (id: string): string => `resource:${id}`;

// ---------------------------------------------------------------------------
// resource_read_file
// ---------------------------------------------------------------------------

const resourceReadFile = defineTool({
  name: 'resource_read_file',
  toolset: 'resources',
  title: 'Read a file of a Library resource',
  description:
    'Reads one text file of a resource’s package (the files resource_get lists, e.g. SKILL.md or references/x.md), ' +
    'up to 100 000 characters, with secrets masked by the server. Credential files and anything outside the ' +
    'package are refused. The content is fenced as untrusted data. A single-file resource (a command, a rule, ' +
    'memory) has its body in resource_get.',
  risk: 'read',
  phase: 1,
  input: {
    id: RESOURCE_ID,
    file: z.string().min(1).max(1_024).describe('The file’s path inside the package, as resource_get lists it.'),
  },
  async run(args, ctx) {
    const answer = await ctx.client.get(`/resources/item/${seg(args.id)}/file`, { path: args.file });
    // AASC refuses, for its own reasons (the route says which, not this tool): the central's scope has nothing to do
    // with it, so this is DENIED rather than NOT_IN_SCOPE, and the words do not name one reason.
    if (!answer.ok && answer.status === 403) {
      throw new ToolError(
        'DENIED',
        'AASC refused to show that file.',
        'AASC never shows credential files or a file that resolves outside the package. Read another file of the package; resource_get lists them.',
      );
    }
    const body = unwrap<unknown>(answer);
    const file = isRecord(body) ? body : {};
    const content = str(file.content);
    const bytes = whole(file.bytes);
    if (content === null) {
      return {
        data: { id: args.id, path: str(file.path) ?? args.file, bytes, binary: file.binary === true, truncated: false, length: 0, content: null },
        summary: `File of resource ${args.id} is binary (${bytes} bytes): AASC shows only text.`,
      };
    }
    const cut = fenced(sourceOf(args.id), 'file', content, FILE_MAX);
    const truncated = cut.truncated || file.truncated === true;
    return {
      data: { id: args.id, path: str(file.path) ?? args.file, bytes, binary: false, truncated, length: cut.length, content: cut.value },
      summary: `File of resource ${args.id} (${bytes} bytes${truncated ? `, truncated at ${FILE_MAX} characters` : ''}):\n${cut.value}`,
    };
  },
});

// ---------------------------------------------------------------------------
// resource_compare
// ---------------------------------------------------------------------------

const resourceCompare = defineTool({
  name: 'resource_compare',
  toolset: 'resources',
  title: 'Compare a Library resource',
  description:
    'Compares a resource with its copy in the agent-manager repository (agent-skills) or with a variant of it ' +
    '(another agent’s resource of the same name; pass its id as against): which files differ, and the unified diff ' +
    'of the main file, up to 20 000 characters, fenced as untrusted data. Says so when there is nothing to compare against.',
  risk: 'read',
  phase: 1,
  input: {
    id: RESOURCE_ID,
    against: z
      .union([z.literal('repo'), z.string().regex(HEX16)])
      .default('repo')
      .describe('`repo` (the default) or the id of a variant of this resource.'),
  },
  async run(args, ctx) {
    const answer = await ctx.client.get(`/resources/item/${seg(args.id)}/compare`, { against: args.against });
    const source = sourceOf(args.id);
    if (!answer.ok && answer.status === 404 && /nothing to compare/i.test(answer.error ?? '')) {
      return {
        data: { id: args.id, against: args.against, comparable: false, left: null, right: null, files: [], patch: null, patchTruncated: false },
        summary: `Nothing to compare resource ${args.id} against: it has no ${args.against === 'repo' ? 'repository copy' : 'such variant'}.`,
      };
    }
    const body = unwrap<unknown>(answer);
    const compare = isRecord(body) ? body : {};
    const side = (raw: unknown): { label: string; path: string } | null =>
      isRecord(raw) ? { label: str(raw.label) ?? '', path: str(raw.path) ?? '' } : null;
    const files = records(compare.files).map((f) => ({ path: str(f.path) ?? '', status: str(f.status) ?? '' }));
    const patchText = str(compare.patch);
    const patch = patchText === null || patchText === '' ? null : clipText(patchText, PATCH_MAX);
    const patchCut = patch !== null && (patch.truncated || compare.patchTruncated === true);
    const left = side(compare.left);
    const right = side(compare.right);
    const data = {
      id: args.id,
      against: args.against,
      comparable: true,
      left,
      right,
      files,
      patch: patch === null ? null : fenced(source, 'diff', patch.text, PATCH_MAX).value,
      patchTruncated: patchCut,
    };
    const differing = files.filter((f) => f.status !== 'same').length;
    const header = [
      `${left?.label ?? 'left'} (${left?.path ?? ''}) against ${right?.label ?? 'right'} (${right?.path ?? ''})`,
      ...files.map((f) => `${f.status} ${f.path}`),
    ];
    const block = fence(source, 'diff', [...header, ...(patch === null ? [] : ['', patch.text])].join('\n'));
    const cut = patchCut ? ` The diff is shown up to ${PATCH_MAX} characters (truncated).` : '';
    return {
      data,
      summary: `Resource ${args.id} compared with ${args.against === 'repo' ? 'its repository copy' : 'a variant'}: ${plural(differing, 'file')} differ.${cut}\n${block}`,
    };
  },
});

// ---------------------------------------------------------------------------
// resource_usage
// ---------------------------------------------------------------------------

const resourceUsage = defineTool({
  name: 'resource_usage',
  toolset: 'resources',
  title: 'How often skills and commands were used',
  description:
    'Counts how often each skill and command was used in the last 90 days, from AASC’s own history: prompts that ' +
    'typed it, times Claude ran it through its Skill tool, when it was last used and how it was typed (/name or ' +
    '$name). The 100 most used, by resource id; resource_list names them. Rules, instructions and memory are ' +
    'loaded, never invoked, so they have no count.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const answer = await ctx.client.get('/resources/usage');
    if (routeMissing(answer)) {
      throw new ToolError('UNAVAILABLE', 'This build of AASC does not count resource uses.', 'resource_list lists the resources without use counts.');
    }
    if (!answer.ok && answer.status === 409) {
      throw new ToolError(
        'UNAVAILABLE',
        'The Library has not been scanned yet, so uses cannot be matched to resources.',
        'Call resource_list to start a scan, wait a few seconds, then ask again.',
      );
    }
    const body = unwrap<unknown>(answer);
    const report = isRecord(body) ? body : {};
    const used = Object.entries(isRecord(report.byId) ? report.byId : {})
      .filter(([id, v]) => HEX16.test(id) && isRecord(v))
      .map(([id, v]) => {
        const use = v as Record<string, unknown>;
        const typed = whole(use.typed);
        const agent = whole(use.agent);
        return { id, typed, agent, total: typed + agent, lastUsedAt: whole(use.lastAt), tokens: strings(use.tokens).slice(0, 6), sharedWith: whole(use.sharedWith) };
      })
      .sort((a, b) => b.total - a.total || b.lastUsedAt - a.lastUsedAt || a.id.localeCompare(b.id));
    const shown = used.slice(0, USAGE_SHOWN);
    const windowDays = whole(report.windowDays);
    const data = { windowDays, count: used.length, shown: shown.length, usage: shown };
    if (used.length === 0) return { data, summary: `No skill or command was used in the last ${windowDays} days.` };
    const rows = shown.map((u) => `${u.id} · ${u.total} uses (${u.typed} typed, ${u.agent} by the agent) · ${u.tokens.join(' ')}`);
    const more = used.length > shown.length ? ` The ${shown.length} most used are listed.` : '';
    return {
      data,
      summary: `${plural(used.length, 'skill or command', 'skills and commands')} used in the last ${windowDays} days.${more}\n${fence('aasc', 'resource-usage', rows.join('\n'))}`,
    };
  },
});

export const resourceFileTools: readonly ToolDef[] = [resourceReadFile, resourceCompare, resourceUsage];
