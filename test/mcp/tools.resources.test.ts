// test/mcp/tools.resources.test.ts — the resources toolset's P1 reads (server/mcp/tools/resources.ts):
// resource_list, resource_get, resource_read_file, resource_compare and resource_usage. They wrap
// /api/resources, the Library of skills, commands, rules, memory, agents, hooks, MCP servers and plugins on this
// Mac. What a file says is text anyone could have written: fenced as untrusted in `data` and in the text. The
// server already masks secrets in what it answers; the tools add nothing to that and take nothing away.
import { describe, expect, it, vi } from 'vitest';
import { blocksIn, deepFreeze, everything, expectFenced, HOSTILE, outsideFences } from './readFixtures.js';
import { dataOf, envelope, fail, makeCentral, makeCtx, makeSession, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const ID = 'a1b2c3d4e5f60718';
const ID2 = '0123456789abcdef';
const ID3 = 'fedcba9876543210';

const summary = (id: string, over: Record<string, unknown> = {}) => ({
  id, type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown', name: 'brainstorming',
  description: 'Explore ideas before building', path: '~/.claude/skills/brainstorming', fileCount: 3, bytes: 4_096,
  hash: 'abc', mtimeMs: 1_700_000_000_000, repo: { status: 'same', path: 'skills/brainstorming' }, variantIds: [ID2], findingCodes: [],
  ...over,
});
const catalog = (resources: unknown[], over: Record<string, unknown> = {}) => ({
  state: 'ready', scannedAt: 1_700_000_001_000, roots: { claude: '~/.claude' }, projects: [], resources, findings: [], coverage: [], ...over,
});

interface RowData {
  id: string; type: string; agent: string; scope: string; origin: string; format: string; name: string; description: string | null;
  path: string; pluginName: string | null; projectId: string | null; fileCount: number; bytes: number; mtimeMs: number | null;
  repoStatus: string | null; variantIds: string[]; findings: string[];
}
interface ListData {
  state: string; scanning: boolean; scannedAt: number | null; total: number; count: number; start: number; returned: number;
  nextCursor: string | null; resources: RowData[];
}

describe('resource_list', () => {
  const resources = [
    summary(ID),
    summary(ID2, { type: 'command', agent: 'codex', name: 'deploy', description: 'Ship it', path: '~/.codex/prompts/deploy.md', format: 'markdown', fileCount: 1 }),
    summary(ID3, { type: 'rule', scope: 'project', projectId: 'p1', name: 'style', description: undefined, path: '~/code/app/.claude/rules/style.md', repo: { status: 'not-tracked' } }),
  ];
  const routes = { 'GET /resources': envelope(catalog(resources)) };

  it('calls GET /resources, which takes no query: the filters are the tool’s', async () => {
    const { ctx, client } = makeCtx({ routes });

    await run('resource_list', { type: 'skill', query: 'brain' }, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/resources' }]);
  });

  it('lists each resource with what a central needs to pick one', async () => {
    const { ctx } = makeCtx({ routes });

    const data = await dataOf<ListData>('resource_list', {}, ctx);

    expect(data).toMatchObject({ state: 'ready', scanning: false, scannedAt: 1_700_000_001_000, total: 3, count: 3, start: 0, returned: 3, nextCursor: null });
    expect(data.resources[0]).toMatchObject({
      id: ID, type: 'skill', agent: 'claude', scope: 'global', origin: 'user', format: 'markdown', name: 'brainstorming',
      path: '~/.claude/skills/brainstorming', pluginName: null, projectId: null, fileCount: 3, bytes: 4_096, repoStatus: 'same', variantIds: [ID2], findings: [],
    });
    expect(data.resources[2]).toMatchObject({ scope: 'project', projectId: 'p1', description: null, repoStatus: 'not-tracked' });
  });

  it('fences each description in the data, as text from a skill file', async () => {
    const { ctx } = makeCtx({ routes });

    const { resources: rows } = await dataOf<ListData>('resource_list', {}, ctx);

    expectFenced(rows[0].description, 'resource-description', `resource:${ID}`);
    expect(rows[0].description).toContain('Explore ideas before building');
  });

  it('filters by type, agent, scope and a text that may be in the name, description or path, in any case', async () => {
    const { ctx } = makeCtx({ routes });
    const ids = async (args: Record<string, unknown>) => (await dataOf<ListData>('resource_list', args, ctx)).resources.map((r) => r.id);

    expect(await ids({ type: 'command' })).toEqual([ID2]);
    expect(await ids({ agent: 'claude' })).toEqual([ID, ID3]);
    expect(await ids({ scope: 'project' })).toEqual([ID3]);
    expect(await ids({ query: 'BRAIN' })).toEqual([ID]);
    expect(await ids({ query: 'ship it' })).toEqual([ID2]);
    expect(await ids({ query: '.codex/prompts' })).toEqual([ID2]);
    expect(await ids({ type: 'skill', agent: 'codex' })).toEqual([]);
    const data = await dataOf<ListData>('resource_list', { type: 'command' }, ctx);
    expect(data).toMatchObject({ total: 3, count: 1 });
  });

  it('pages with a cursor and a limit, 100 to a page by default', async () => {
    const many = Array.from({ length: 230 }, (_, i) => summary(i.toString(16).padStart(16, '0'), { name: `skill-${i}` }));
    const { ctx } = makeCtx({ routes: { 'GET /resources': envelope(catalog(many)) } });

    const first = await dataOf<ListData>('resource_list', {}, ctx);
    const second = await dataOf<ListData>('resource_list', { cursor: first.nextCursor ?? '', limit: 200 }, ctx);

    expect(first).toMatchObject({ count: 230, start: 0, returned: 100, nextCursor: '100' });
    expect(second).toMatchObject({ start: 100, returned: 130, nextCursor: null });
    expect(second.resources[0].name).toBe('skill-100');
    await expect(run('resource_list', { limit: 201 }, ctx)).rejects.toThrow(/limit/);
  });

  it('says a scan is running when the Library has not been scanned yet', async () => {
    const scanning = catalog([], { state: 'scanning', scannedAt: undefined });
    const { ctx } = makeCtx({ routes: { 'GET /resources': envelope(scanning) } });

    const result = await run('resource_list', {}, ctx);

    expect(result.data).toMatchObject({ state: 'scanning', scanning: true, total: 0, resources: [], scannedAt: null });
    expect(result.summary).toMatch(/scan/i);
  });

  it('keeps hostile text inside its fence, and puts the rows in one block', async () => {
    const evil = summary(ID, { name: 'x', description: HOSTILE });
    const { ctx } = makeCtx({ routes: { 'GET /resources': envelope(catalog([evil])) } });

    const result = await run('resource_list', {}, ctx);

    expectFenced((result.data as ListData).resources[0].description, 'resource-description');
    expect(blocksIn(result.summary)).toBe(1);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('skips entries the route describes without an id or with one the Library never makes (16 lower-case hex), and changes nothing it reads', async () => {
    const odd = [null, 'x', { name: 'no id' }, summary('NOT-A-HEX-ID'), summary(ID.toUpperCase()), summary(`${ID}0`), summary('../etc/passwd')];
    const frozen = deepFreeze(JSON.parse(JSON.stringify(catalog([...resources, ...odd]))));
    const { ctx } = makeCtx({ routes: { 'GET /resources': envelope(frozen) } });

    const data = await dataOf<ListData>('resource_list', {}, ctx);

    expect(data.total).toBe(3);
  });

  it('turns a failed route into a refusal', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /resources': fail(503, 'down') } });

    expect((await runRefused('resource_list', {}, ctx)).code).toBe('UNAVAILABLE');
  });

  it('is open to a room central too: the Library is the Mac’s, not a session’s', async () => {
    const { ctx } = makeCtx({ central: makeCentral('room', 'r1'), sessions: [makeSession('s1')], routes });

    expect((await dataOf<ListData>('resource_list', {}, ctx)).total).toBe(3);
  });
});

interface DetailData {
  id: string;
  resource: RowData;
  frontmatter: string | null;
  frontmatterError: string | null;
  body: string | null;
  bodyTruncated: boolean;
  bodyLength: number;
  fields: Array<{ key: string; value: string; valueTruncated: boolean; masked: boolean; kind: string }> | null;
  files: Array<{ path: string; bytes: number; isText: boolean; isSymlink: boolean }> | null;
  findings: Array<{ code: string; severity: string; message: string; path: string | null }>;
}

describe('resource_get', () => {
  const detail = {
    summary: summary(ID),
    frontmatter: { name: 'brainstorming', description: 'Explore ideas', 'allowed-tools': ['Read'] },
    body: '# Brainstorming\n\nAsk one question at a time.',
    files: [{ path: 'SKILL.md', bytes: 120, isText: true }, { path: 'assets/logo.png', bytes: 900, isText: false, isSymlink: true }],
    findings: [{ code: 'name-mismatch', severity: 'warning', resourceId: ID, message: 'The name differs from the folder', path: '~/.claude/skills/brainstorming' }],
  };
  const routes = { [`GET /resources/item/${ID}`]: envelope(detail) };

  it('calls GET /resources/item/<id>', async () => {
    const { ctx, client } = makeCtx({ routes });

    await run('resource_get', { id: ID }, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: `/resources/item/${ID}` }]);
  });

  it('takes only an id as the Library makes one: 16 hex characters', async () => {
    const { ctx } = makeCtx({ routes });

    for (const bad of ['../etc', ID.toUpperCase(), 'a1b2', `${ID}0`, '']) {
      await expect(run('resource_get', { id: bad }, ctx), bad).rejects.toThrow(/id/);
    }
  });

  it('describes the resource: its row, frontmatter, body, package files and findings', async () => {
    const { ctx } = makeCtx({ routes });

    const data = await dataOf<DetailData>('resource_get', { id: ID }, ctx);

    expect(data.id).toBe(ID);
    expect(data.resource).toMatchObject({ id: ID, type: 'skill', name: 'brainstorming', fileCount: 3 });
    expect(data.bodyTruncated).toBe(false);
    expect(data.bodyLength).toBe(detail.body.length);
    expect(data.fields).toBeNull();
    expect(data.files).toEqual([
      { path: 'SKILL.md', bytes: 120, isText: true, isSymlink: false },
      { path: 'assets/logo.png', bytes: 900, isText: false, isSymlink: true },
    ]);
    expect(data.findings).toMatchObject([{ code: 'name-mismatch', severity: 'warning', path: '~/.claude/skills/brainstorming' }]);
  });

  it('fences the body (kind file), the frontmatter, the description and each finding’s message', async () => {
    const { ctx } = makeCtx({ routes });

    const data = await dataOf<DetailData>('resource_get', { id: ID }, ctx);

    expectFenced(data.body, 'file', `resource:${ID}`);
    expect(data.body).toContain('Ask one question at a time.');
    expectFenced(data.frontmatter, 'frontmatter', `resource:${ID}`);
    expect(data.frontmatter).toContain('allowed-tools');
    expectFenced(data.resource.description, 'resource-description', `resource:${ID}`);
    expectFenced(data.findings[0].message, 'finding', `resource:${ID}`);
  });

  it('lists a config resource’s fields with each value fenced, as the server masked it', async () => {
    const config = {
      summary: summary(ID, { type: 'mcp', format: 'config', name: 'kason' }),
      fields: [
        { key: 'mcp_servers.kason.command', value: 'npx kason', masked: false, kind: 'string' },
        { key: 'mcp_servers.kason.env.API_KEY', value: '••••••', masked: true, kind: 'string' },
      ],
      findings: [],
    };
    const { ctx } = makeCtx({ routes: { [`GET /resources/item/${ID}`]: envelope(config) } });

    const data = await dataOf<DetailData>('resource_get', { id: ID }, ctx);

    expect(data.fields?.map((f) => [f.key, f.masked, f.kind])).toEqual([
      ['mcp_servers.kason.command', false, 'string'],
      ['mcp_servers.kason.env.API_KEY', true, 'string'],
    ]);
    for (const field of data.fields ?? []) expectFenced(field.value, 'config-value', `resource:${ID}`);
    expect(data.body).toBeNull();
    expect(data.frontmatter).toBeNull();
  });

  it('cuts a config value at 1 000 characters and says so, and says nothing of a short one', async () => {
    const config = {
      summary: summary(ID, { type: 'mcp', format: 'config', name: 'kason' }),
      fields: [{ key: 'a', value: 'v'.repeat(3_000), masked: false, kind: 'string' }, { key: 'b', value: 'short', masked: false, kind: 'string' }],
      findings: [],
    };
    const { ctx } = makeCtx({ routes: { [`GET /resources/item/${ID}`]: envelope(config) } });

    const data = await dataOf<DetailData>('resource_get', { id: ID }, ctx);

    expect(data.fields?.map((f) => f.valueTruncated)).toEqual([true, false]);
    expect(data.fields?.[0].value.length).toBeLessThan(1_200);
  });

  it('cuts a very long body at 100 000 characters and says it was cut', async () => {
    const long = { ...detail, body: 'b'.repeat(150_000), bodyTruncated: false };
    const { ctx } = makeCtx({ routes: { [`GET /resources/item/${ID}`]: envelope(long) } });

    const result = await run('resource_get', { id: ID }, ctx);
    const data = result.data as DetailData;

    expect(data.bodyTruncated).toBe(true);
    expect(data.bodyLength).toBe(150_000);
    expect(data.body?.length).toBeLessThan(100_200);
    expect(result.summary).toMatch(/truncated/i);
    expect(result.summary.length).toBeLessThan(105_000);
  });

  it('passes on the server’s own cut of a body', async () => {
    const cut = { ...detail, bodyTruncated: true };
    const { ctx } = makeCtx({ routes: { [`GET /resources/item/${ID}`]: envelope(cut) } });

    const result = await run('resource_get', { id: ID }, ctx);

    expect((result.data as DetailData).bodyTruncated).toBe(true);
    expect(result.summary).toMatch(/truncated/i);
  });

  it('keeps hostile text inside fences: the text holds a block for the resource and a block for the file', async () => {
    const evil = { ...detail, summary: summary(ID, { description: HOSTILE }), body: HOSTILE, frontmatter: { a: HOSTILE }, findings: [] };
    const { ctx } = makeCtx({ routes: { [`GET /resources/item/${ID}`]: envelope(evil) } });

    const result = await run('resource_get', { id: ID }, ctx);

    expect(blocksIn(result.summary)).toBe(2);
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
    expect(result.summary).toContain('kind="file"');
  });

  it('answers a missing resource as not found, never repeating the id', async () => {
    const { ctx } = makeCtx({ routes: { [`GET /resources/item/${ID}`]: fail(404, 'Resource not found') } });

    const err = await runRefused('resource_get', { id: ID }, ctx);

    expect(err.code).toBe('NOT_FOUND');
    expect(`${err.message} ${err.hint}`).not.toContain(ID);
  });

  it('changes nothing it reads', async () => {
    const frozen = deepFreeze(JSON.parse(JSON.stringify(detail)));
    const { ctx } = makeCtx({ routes: { [`GET /resources/item/${ID}`]: envelope(frozen) } });

    await expect(run('resource_get', { id: ID }, ctx)).resolves.toBeDefined();
  });
});

interface FileData {
  id: string; path: string; bytes: number; binary: boolean; truncated: boolean; length: number; content: string | null;
}

describe('resource_read_file', () => {
  const file = (over: Record<string, unknown> = {}) => envelope({ path: 'SKILL.md', bytes: 44, content: '# Skill\nDo the thing.', ...over });
  const path = `/resources/item/${ID}/file`;

  it('calls GET /resources/item/<id>/file with the file as the route’s path query', async () => {
    const { ctx, client } = makeCtx({ routes: { [`GET ${path}`]: file() } });

    await run('resource_read_file', { id: ID, file: 'SKILL.md' }, ctx);
    await run('resource_read_file', { id: ID, file: 'references/a b.md' }, ctx);

    expect(client.calls).toEqual([
      { method: 'GET', path, query: { path: 'SKILL.md' } },
      { method: 'GET', path, query: { path: 'references/a b.md' } },
    ]);
  });

  it('gives the file as one fenced body of kind file, in the data and in the text', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: file() } });

    const result = await run('resource_read_file', { id: ID, file: 'SKILL.md' }, ctx);
    const data = result.data as FileData;

    expect(data).toMatchObject({ id: ID, path: 'SKILL.md', bytes: 44, binary: false, truncated: false, length: 21 });
    expectFenced(data.content, 'file', `resource:${ID}`);
    expect(data.content).toContain('Do the thing.');
    expect(result.summary).toContain('<untrusted source="resource:' + ID + '" kind="file">');
    expect(blocksIn(result.summary)).toBe(1);
  });

  it('passes the server’s masking through: a masked secret stays masked, and nothing is unmasked', async () => {
    const masked = file({ content: 'API_KEY=••••••\nHOST=example.test' });
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: masked } });

    const result = await run('resource_read_file', { id: ID, file: '.env.example' }, ctx);

    expect(everything(result)).toContain('API_KEY=••••••');
  });

  it('cuts a file at 100 000 characters and says it was truncated', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: file({ content: 'c'.repeat(130_000), bytes: 130_000 }) } });

    const result = await run('resource_read_file', { id: ID, file: 'big.md' }, ctx);
    const data = result.data as FileData;

    expect(data.truncated).toBe(true);
    expect(data.length).toBe(130_000);
    expect(data.content?.length).toBeLessThan(100_200);
    expect(result.summary).toMatch(/truncated/i);
  });

  it('passes on a cut the server made (its cap is 512 KB)', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: file({ truncated: true }) } });

    const result = await run('resource_read_file', { id: ID, file: 'big.md' }, ctx);

    expect((result.data as FileData).truncated).toBe(true);
    expect(result.summary).toMatch(/truncated/i);
  });

  it('says a binary file is binary, with no content', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: envelope({ path: 'logo.png', bytes: 900, binary: true }) } });

    const result = await run('resource_read_file', { id: ID, file: 'logo.png' }, ctx);

    expect(result.data).toMatchObject({ binary: true, content: null, length: 0 });
    expect(result.summary).toMatch(/binary/i);
    expect(blocksIn(result.summary)).toBe(0);
  });

  it('keeps hostile text inside its fence', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: file({ content: HOSTILE }) } });

    const result = await run('resource_read_file', { id: ID, file: 'SKILL.md' }, ctx);

    expectFenced((result.data as FileData).content, 'file');
    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
  });

  it('says AASC refused a file the server will not show, as DENIED and not as out of the central’s scope; a bad path is invalid', async () => {
    const credentials = makeCtx({ routes: { [`GET ${path}`]: fail(403, 'Credential files are never read') } });
    const outside = makeCtx({ routes: { [`GET ${path}`]: fail(403, 'Not read: the file resolves outside the package') } });
    const invalid = makeCtx({ routes: { [`GET ${path}`]: fail(400, 'path: Not part of the package') } });
    const missing = makeCtx({ routes: { [`GET ${path}`]: fail(404, 'Not found') } });

    for (const refused of [credentials, outside]) {
      const err = await runRefused('resource_read_file', { id: ID, file: '.env' }, refused.ctx);

      expect(err.code).toBe('DENIED');
      // It does not claim a reason the route did not give: a credential file is one of two things AASC refuses.
      expect(err.message).toBe('AASC refused to show that file.');
      expect(err.hint).toMatch(/credential/i);
      expect(err.hint).toMatch(/outside the package/i);
    }
    expect((await runRefused('resource_read_file', { id: ID, file: '../x' }, invalid.ctx)).code).toBe('INVALID');
    expect((await runRefused('resource_read_file', { id: ID, file: 'nope.md' }, missing.ctx)).code).toBe('NOT_FOUND');
  });

  it('takes a file name of sensible length, and never repeats it back in a refusal', async () => {
    const needle = 'UNIQUE-NEEDLE-FILE-9';
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: fail(404, 'Not found') } });

    await expect(run('resource_read_file', { id: ID, file: '' }, ctx)).rejects.toThrow(/file/);
    await expect(run('resource_read_file', { id: ID, file: 'x'.repeat(1_025) }, ctx)).rejects.toThrow(/file/);
    const err = await runRefused('resource_read_file', { id: ID, file: needle }, ctx);
    expect(`${err.message} ${err.hint}`).not.toContain(needle);
  });
});

interface CompareData {
  id: string; against: string; comparable: boolean;
  left: { label: string; path: string } | null; right: { label: string; path: string } | null;
  files: Array<{ path: string; status: string }>; patch: string | null; patchTruncated: boolean;
}

describe('resource_compare', () => {
  const compare = {
    left: { label: 'This Mac', path: '~/.claude/skills/brainstorming' },
    right: { label: 'agent-skills', path: 'skills/brainstorming' },
    files: [{ path: 'SKILL.md', status: 'changed' }, { path: 'notes.md', status: 'only-left' }],
    patch: '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n',
  };
  const path = `/resources/item/${ID}/compare`;

  it('calls GET /resources/item/<id>/compare against the repository copy unless told otherwise', async () => {
    const { ctx, client } = makeCtx({ routes: { [`GET ${path}`]: envelope(compare) } });

    await run('resource_compare', { id: ID }, ctx);
    await run('resource_compare', { id: ID, against: ID2 }, ctx);
    await run('resource_compare', { id: ID, against: 'repo' }, ctx);

    expect(client.calls.map((c) => c.query)).toEqual([{ against: 'repo' }, { against: ID2 }, { against: 'repo' }]);
    expect(client.calls.every((c) => c.method === 'GET' && c.path === path)).toBe(true);
    await expect(run('resource_compare', { id: ID, against: 'elsewhere' }, ctx)).rejects.toThrow(/against/);
  });

  it('shows both sides, the files that differ and the diff of the main file, fenced', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: envelope(compare) } });

    const result = await run('resource_compare', { id: ID }, ctx);
    const data = result.data as CompareData;

    expect(data).toMatchObject({ id: ID, against: 'repo', comparable: true, patchTruncated: false });
    expect(data.left).toEqual({ label: 'This Mac', path: '~/.claude/skills/brainstorming' });
    expect(data.files).toEqual([{ path: 'SKILL.md', status: 'changed' }, { path: 'notes.md', status: 'only-left' }]);
    expectFenced(data.patch, 'diff', `resource:${ID}`);
    expect(data.patch).toContain('+new');
    expect(result.summary).toContain('kind="diff"');
    expect(blocksIn(result.summary)).toBe(1);
  });

  it('cuts a long diff at 20 000 characters and says so', async () => {
    const long = { ...compare, patch: `+${'d'.repeat(30_000)}` };
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: envelope(long) } });

    const result = await run('resource_compare', { id: ID }, ctx);

    expect((result.data as CompareData).patchTruncated).toBe(true);
    expect((result.data as CompareData).patch?.length).toBeLessThan(20_200);
    expect(result.summary).toMatch(/truncated/i);
  });

  it('answers “nothing to compare against” as an answer, not an error', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: fail(404, 'Nothing to compare against') } });

    const result = await run('resource_compare', { id: ID }, ctx);

    expect(result.data).toMatchObject({ comparable: false, left: null, right: null, files: [], patch: null });
    expect(result.summary).toMatch(/nothing to compare/i);
  });

  it('answers a resource that does not exist as not found', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: fail(404, 'Resource not found') } });

    expect((await runRefused('resource_compare', { id: ID }, ctx)).code).toBe('NOT_FOUND');
  });

  it('keeps hostile text in a diff inside its fence', async () => {
    const { ctx } = makeCtx({ routes: { [`GET ${path}`]: envelope({ ...compare, patch: `+${HOSTILE}` }) } });

    const result = await run('resource_compare', { id: ID }, ctx);

    expect(outsideFences(result.summary)).not.toMatch(/SYSTEM|rm -rf|Ignore all/);
    expectFenced((result.data as CompareData).patch, 'diff');
  });
});

interface UsageData {
  windowDays: number; count: number; shown: number;
  usage: Array<{ id: string; typed: number; agent: number; total: number; lastUsedAt: number; tokens: string[]; sharedWith: number }>;
}

describe('resource_usage', () => {
  const report = {
    windowDays: 90,
    byId: {
      [ID]: { typed: 4, agent: 2, lastAt: 1_700_000_000_000, tokens: ['/brainstorming', '/superpowers:brainstorming'] },
      [ID2]: { typed: 9, agent: 0, lastAt: 1_700_000_500_000, tokens: ['$deploy'], sharedWith: 1 },
      [ID3]: { typed: 1, agent: 0, lastAt: 5, tokens: ['/style'] },
      'not-an-id': { typed: 99, agent: 99, lastAt: 1, tokens: [] },
    },
  };

  it('calls GET /resources/usage', async () => {
    const { ctx, client } = makeCtx({ routes: { 'GET /resources/usage': envelope(report) } });

    await run('resource_usage', {}, ctx);

    expect(client.calls).toEqual([{ method: 'GET', path: '/resources/usage' }]);
  });

  it('lists the most used first, with typed and agent uses added up, the last use and how it was typed', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /resources/usage': envelope(report) } });

    const data = await dataOf<UsageData>('resource_usage', {}, ctx);

    expect(data).toMatchObject({ windowDays: 90, count: 3, shown: 3 });
    expect(data.usage.map((u) => [u.id, u.total])).toEqual([[ID2, 9], [ID, 6], [ID3, 1]]);
    expect(data.usage[0]).toEqual({ id: ID2, typed: 9, agent: 0, total: 9, lastUsedAt: 1_700_000_500_000, tokens: ['$deploy'], sharedWith: 1 });
    expect(data.usage[1].sharedWith).toBe(0);
  });

  it('shows the 100 most used and counts the rest', async () => {
    const byId = Object.fromEntries(Array.from({ length: 130 }, (_, i) => [i.toString(16).padStart(16, '0'), { typed: i + 1, agent: 0, lastAt: i, tokens: [`/s${i}`] }]));
    const { ctx } = makeCtx({ routes: { 'GET /resources/usage': envelope({ windowDays: 90, byId }) } });

    const data = await dataOf<UsageData>('resource_usage', {}, ctx);

    expect(data).toMatchObject({ count: 130, shown: 100 });
    expect(data.usage[0].total).toBe(130);
  });

  it('says so when nothing was used', async () => {
    const { ctx } = makeCtx({ routes: { 'GET /resources/usage': envelope({ windowDays: 90, byId: {} }) } });

    const result = await run('resource_usage', {}, ctx);

    expect(result.summary).toMatch(/No skill or command was used/);
  });

  it('answers UNAVAILABLE where this build of AASC has no such route: a 404, a 415, or the app’s page', async () => {
    for (const answer of [fail(404, 'Not found'), fail(415, 'Content-Type must be application/json'), ok(null)]) {
      const { ctx } = makeCtx({ routes: { 'GET /resources/usage': answer } });

      const err = await runRefused('resource_usage', {}, ctx);

      expect(err.code).toBe('UNAVAILABLE');
      expect(err.message).toMatch(/does not count/i);
    }
  });

  it('says to scan first when the Library has not been scanned (the route’s 409), and retry on its 503', async () => {
    const early = makeCtx({ routes: { 'GET /resources/usage': fail(409, 'The resources have not been scanned yet') } });
    const unknown = makeCtx({ routes: { 'GET /resources/usage': fail(503, 'Could not count resource uses') } });

    const first = await runRefused('resource_usage', {}, early.ctx);
    const second = await runRefused('resource_usage', {}, unknown.ctx);

    expect(first.code).toBe('UNAVAILABLE');
    expect(first.hint).toMatch(/resource_list/);
    expect(second.code).toBe('UNAVAILABLE');
  });
});
