// tools/resources.ts — the resources toolset, P1: the Library of skills, commands, rules, memory, agents, hooks,
// MCP servers and plugins on this Mac (`/api/resources`): the list and what one resource holds. A file of it, how it
// differs from its repository copy and how often it was used are in resourceFiles.ts. Read only here; the P3 writes
// (a rescan, abbreviation commands) are in resourceWrite.ts, and P5's uninstall and restore in resourceRemove.ts.
//
// The Library belongs to the Mac, not to a session: every central that has the toolset may read it, whatever
// its scope. What a file says is text anyone who wrote a skill or a plugin could have written, so a description,
// a body, a frontmatter, a config value and a diff are fenced as untrusted in `data` and in the text; ids, names,
// display paths, sizes and counts stay plain. Secrets are masked by the server before it answers; these tools
// pass that through and add no masking of their own.

import { z } from 'zod';
import { RESOURCE_TYPES } from '../../../src/types/resources.js';
import type { ToolDef } from '../registry.js';
import { defineTool, fence, isRecord, oneLine, plain, plural, seg, unwrap } from './define.js';
import { FILE_MAX, HEX16, RESOURCE_ID, resourceFileTools, sourceOf } from './resourceFiles.js';
import { resourceRemoveTools } from './resourceRemove.js';
import { resourceWriteTools } from './resourceWrite.js';
import { CURSOR_INPUT, fenced, limitInput, list, num, pageOf, pageWords, records, str, strings, whole } from './shape.js';

const PAGE_DEFAULT = 100;
const PAGE_MAX = 200;
const DESCRIPTION_MAX = 300;
const FIELD_VALUE_MAX = 1_000;
const FIELDS_MAX = 200;
const FILES_MAX = 200;
const FINDINGS_MAX = 50;

// ---------------------------------------------------------------------------
// A resource as a row
// ---------------------------------------------------------------------------

interface ResourceRow {
  id: string;
  type: string;
  agent: string;
  scope: string;
  origin: string;
  format: string;
  name: string;
  /** Fenced as untrusted; null when it has none. */
  description: string | null;
  path: string;
  pluginName: string | null;
  projectId: string | null;
  fileCount: number;
  bytes: number;
  mtimeMs: number | null;
  repoStatus: string | null;
  variantIds: string[];
  findings: string[];
}

interface Parsed {
  row: ResourceRow;
  /** The description as the file wrote it, for filtering and for the text. */
  description: string;
}

/** One catalog entry, read loosely; null for one with no usable id. */
function parseResource(raw: unknown): Parsed | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (id === null || !HEX16.test(id)) return null;
  const description = str(raw.description) ?? '';
  const repo = isRecord(raw.repo) ? str(raw.repo.status) : null;
  const row: ResourceRow = {
    id,
    type: str(raw.type) ?? '',
    agent: str(raw.agent) ?? '',
    scope: str(raw.scope) ?? '',
    origin: str(raw.origin) ?? '',
    format: str(raw.format) ?? '',
    name: str(raw.name) ?? '',
    description: description === '' ? null : fenced(sourceOf(id), 'resource-description', description, DESCRIPTION_MAX).value,
    path: str(raw.path) ?? '',
    pluginName: str(raw.pluginName),
    projectId: str(raw.projectId),
    fileCount: whole(raw.fileCount),
    bytes: whole(raw.bytes),
    mtimeMs: num(raw.mtimeMs),
    repoStatus: repo,
    variantIds: strings(raw.variantIds).filter((v) => HEX16.test(v)),
    findings: strings(raw.findingCodes),
  };
  return { row, description };
}

/** One row of the text: everything on it is inside the block that holds it. */
function rowText(p: Parsed): string {
  const { row } = p;
  const lead = `${row.id} · ${row.type} · ${row.agent} · ${row.scope} · ${row.name} · ${row.path}`;
  return p.description === '' ? lead : `${lead} · ${oneLine(p.description, 100)}`;
}

// ---------------------------------------------------------------------------
// resource_list
// ---------------------------------------------------------------------------

interface ListFilter {
  type?: string;
  agent?: string;
  scope?: string;
  query?: string;
}

function matches(p: Parsed, f: ListFilter): boolean {
  const { row } = p;
  if (f.type !== undefined && row.type !== f.type) return false;
  if (f.agent !== undefined && row.agent !== f.agent) return false;
  if (f.scope !== undefined && row.scope !== f.scope) return false;
  if (f.query === undefined) return true;
  const needle = f.query.trim().toLowerCase();
  return [row.name, p.description, row.path].some((s) => s.toLowerCase().includes(needle));
}

const resourceList = defineTool({
  name: 'resource_list',
  toolset: 'resources',
  title: 'List Library resources',
  description:
    'Lists the skills, commands, rules, instructions, memory, agents, hooks, MCP servers, plugins and settings of ' +
    'this Mac’s Library, global and per project: id, type, agent (claude, codex, shared), scope, origin, name, ' +
    'display path, size, and how it compares with its repository copy. Filter by type, agent, scope or a text in ' +
    'the name, description or path. 100 to a page; pass nextCursor back as cursor. Descriptions are fenced as ' +
    'untrusted data. The first call after AASC starts begins a scan; ask again in a few seconds.',
  risk: 'read',
  phase: 1,
  input: {
    type: z.enum(RESOURCE_TYPES).optional().describe('Only this type of resource.'),
    agent: z.enum(['claude', 'codex', 'shared']).optional().describe('Only resources this agent reads.'),
    scope: z.enum(['global', 'project']).optional().describe('Only global resources, or only a project’s own.'),
    query: z.string().trim().min(1).max(200).optional().describe('Only resources with this text in the name, description or path (any case).'),
    cursor: CURSOR_INPUT,
    limit: limitInput(PAGE_MAX, PAGE_DEFAULT),
  },
  async run(args, ctx) {
    const body = unwrap<unknown>(await ctx.client.get('/resources'));
    const catalog = isRecord(body) ? body : {};
    const all = list(catalog.resources).flatMap((raw) => {
      const parsed = parseResource(raw);
      return parsed === null ? [] : [parsed];
    });
    const found = all.filter((p) => matches(p, args));
    const page = pageOf(found.length, args.cursor, args.limit ?? PAGE_DEFAULT);
    const shown = found.slice(page.start, page.end);
    const state = str(catalog.state) ?? 'idle';
    const data = {
      state,
      scanning: state === 'scanning',
      scannedAt: num(catalog.scannedAt),
      total: all.length,
      count: found.length,
      start: page.start,
      returned: shown.length,
      nextCursor: page.next,
      resources: shown.map((p) => p.row),
    };
    if (state === 'scanning' && all.length === 0) {
      return { data, summary: 'The Library is being scanned for the first time: ask again in a few seconds.' };
    }
    if (shown.length === 0) {
      return { data, summary: found.length === 0 ? `No resource matches (${plural(all.length, 'resource')} in the Library).` : 'The cursor is past the end of the list.' };
    }
    const { of, range, more } = pageWords(page, found.length, all.length);
    const scan = state === 'scanning' ? ' A scan is still running, so the list may grow.' : '';
    const lead = `${plural(found.length, 'resource')}${of} in the Library${range}.${more}${scan}`;
    return { data, summary: `${lead}\n${fence('aasc', 'resources', shown.map(rowText).join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// resource_get
// ---------------------------------------------------------------------------

/** The frontmatter as one line of JSON, or '' for none. */
function frontmatterText(frontmatter: unknown): string {
  if (!isRecord(frontmatter)) return '';
  try {
    return JSON.stringify(frontmatter) ?? '';
  } catch {
    return '';
  }
}

const resourceGet = defineTool({
  name: 'resource_get',
  toolset: 'resources',
  title: 'Describe a Library resource',
  description:
    'Describes one Library resource: its row, its parsed frontmatter, its main file body (up to 100 000 ' +
    'characters), a config resource’s fields (values masked by the server), a skill’s package files and the checks ' +
    'that flagged it. Everything a file wrote is fenced as untrusted data; use resource_read_file for another ' +
    'file of a skill’s package.',
  risk: 'read',
  phase: 1,
  input: { id: RESOURCE_ID },
  async run(args, ctx) {
    const body = unwrap<unknown>(await ctx.client.get(`/resources/item/${seg(args.id)}`));
    const detail = isRecord(body) ? body : {};
    const parsed = parseResource(detail.summary) ?? parseResource({ id: args.id });
    const source = sourceOf(args.id);
    const row = parsed?.row;
    const bodyText = str(detail.body);
    const cutBody = bodyText === null ? null : fenced(source, 'file', bodyText, FILE_MAX);
    const bodyCut = cutBody !== null && (cutBody.truncated || detail.bodyTruncated === true);
    const frontmatter = frontmatterText(detail.frontmatter);
    const frontmatterError = str(detail.frontmatterError);
    const fieldRows = detail.fields === undefined ? null : records(detail.fields);
    const fileRows = detail.files === undefined ? null : records(detail.files);
    const findings = records(detail.findings);
    const data = {
      id: args.id,
      resource: row ?? null,
      frontmatter: frontmatter === '' ? null : fenced(source, 'frontmatter', frontmatter, FILE_MAX).value,
      frontmatterError: frontmatterError === null || frontmatterError === '' ? null : fenced(source, 'frontmatter-error', frontmatterError, DESCRIPTION_MAX).value,
      body: cutBody?.value ?? null,
      bodyTruncated: bodyCut,
      bodyLength: cutBody?.length ?? 0,
      fieldCount: fieldRows?.length ?? 0,
      fields: fieldRows === null ? null : fieldRows.slice(0, FIELDS_MAX).map((f) => {
        const value = fenced(source, 'config-value', str(f.value) ?? '', FIELD_VALUE_MAX);
        return { key: str(f.key) ?? '', value: value.value, valueTruncated: value.truncated, masked: f.masked === true, kind: str(f.kind) ?? 'string' };
      }),
      fileCount: fileRows?.length ?? 0,
      files: fileRows === null ? null : fileRows.slice(0, FILES_MAX).map((f) => ({
        path: str(f.path) ?? '',
        bytes: whole(f.bytes),
        isText: f.isText === true,
        isSymlink: f.isSymlink === true,
      })),
      findings: findings.slice(0, FINDINGS_MAX).map((f) => ({
        code: str(f.code) ?? '',
        severity: str(f.severity) ?? 'info',
        message: fenced(source, 'finding', str(f.message) ?? '', DESCRIPTION_MAX).value,
        path: str(f.path),
      })),
    };
    const lines = [
      row ? `name ${JSON.stringify(row.name)} · ${row.path}` : null,
      parsed && parsed.description !== '' ? `description: ${oneLine(parsed.description, 300)}` : null,
      frontmatter === '' ? null : `frontmatter: ${oneLine(frontmatter, 600)}`,
      ...(fieldRows ?? []).slice(0, FIELDS_MAX).map((f) => `${str(f.key) ?? ''} = ${oneLine(str(f.value) ?? '', 160)}${f.masked === true ? ' (masked)' : ''}`),
      ...(fileRows ?? []).slice(0, FILES_MAX).map((f) => `file ${str(f.path) ?? ''} (${whole(f.bytes)} bytes${f.isText === true ? '' : ', not text'})`),
      ...findings.slice(0, FINDINGS_MAX).map((f) => `${str(f.severity) ?? 'info'} ${str(f.code) ?? ''}: ${oneLine(str(f.message) ?? '', 160)}`),
    ].filter((l): l is string => l !== null);
    const facts = row
      ? `Resource ${args.id} is a ${plain(row.type, 20)} for ${plain(row.agent, 20)} (${plain(row.scope, 20)}, ${plain(row.origin, 20)}), ${plural(row.fileCount, 'file')}, ${row.bytes} bytes.`
      : `Resource ${args.id}.`;
    const cut = bodyCut ? ` Its body is shown up to ${FILE_MAX} characters (truncated).` : '';
    const blocks = [
      lines.length === 0 ? null : fence(source, 'resource', lines.join('\n')),
      cutBody === null ? null : cutBody.value,
    ].filter((b): b is string => b !== null);
    return { data, summary: [`${facts}${cut}`, ...blocks].join('\n') };
  },
});

export const resourceTools: readonly ToolDef[] = [resourceList, resourceGet, ...resourceFileTools, ...resourceWriteTools, ...resourceRemoveTools];
