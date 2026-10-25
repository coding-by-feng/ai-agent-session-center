// test/mcp/cloudToolSources.test.ts — the P6 cloud tool modules, held by their sources, their lists and their runs (plan
// 2026-10-25 P6, Global Constraints and P6-6):
//   * nothing leaves the Mac except through AASC's own routes: a P6 module (every server/mcp/tools/cloud*.ts but P1's
//     cloud.ts, cloudCall.ts and cloudProjects.ts, and server/mcp/cloudMemo.ts), and every module it imports for its
//     values, transitively, imports only zod, node:crypto, node:os and node:path from outside the repo, never
//     server/cloud; and a P6 module's code names no fetch, globalThis, process, require, createRequire,
//     getBuiltinModule, eval or Function, and imports nothing dynamically but a relative module;
//   * only cloudWrite.ts names `boundTo` or `boundGet` (inside `liveAccount`), and the run of a tool that waits for the
//     person names no `liveAccount`, `reviewAccount`, `cloudStatus` or `readStatus`;
//   * what the run of every such tool does, whoever made it: with the person's allow but no review of the call behind it,
//     it is INVALID and calls nothing; after a review as account A and a switch to B, it reads no status and every call
//     it makes names A;
//   * `cloudTools` ends with `cloudP6Tools`, each of them phase 6 in the cloud toolset;
//   * the P1 view builders taken out for C3 and C4 (`remoteViewOf`, `localOf`) answer what the P1 tools answer.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rememberPlan, resetCloudMemo } from '../../server/mcp/cloudMemo.js';
import type { ToolDef } from '../../server/mcp/registry.js';
import { remoteViewOf, cloudTools } from '../../server/mcp/tools/cloud.js';
import { cloudP6Tools } from '../../server/mcp/tools/cloudP6.js';
import { localOf } from '../../server/mcp/tools/cloudProjects.js';
import { resetCloudBudget, reviewAccount } from '../../server/mcp/tools/cloudWrite.js';
import { ToolError, WAITS_FOR_PERSON } from '../../server/mcp/types.js';
import { ACCOUNT, BACKEND, CLOUD_HEADERS, connectedStatus, NOTES_HEADERS, PROJECT_ID, STATUS_PATH } from './cloudFixtures.js';
import { LOCAL_BRANCH, LOCAL_MAIN, REMOTE_VIEW } from './cloudMainShapes.js';
import { cloudCtx, switchAccount } from './cloudWriteKit.js';
import { envelope, makeCtx, NOW, run, type Answer } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const ROOT = join(__dirname, '..', '..');
const source = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const TOOLS_DIR = 'server/mcp/tools';
/** P1's cloud modules: the reads, which name the live binding themselves and predate the P6 rules. */
const P1_CLOUD: ReadonlySet<string> = new Set(['cloud.ts', 'cloudCall.ts', 'cloudProjects.ts']);

/** Every P6 module: each server/mcp/tools/cloud*.ts but P1's, and the memo. */
const P6_MODULES = [
  ...readdirSync(join(ROOT, TOOLS_DIR))
    .filter((f) => /^cloud.*\.ts$/.test(f) && !P1_CLOUD.has(f))
    .sort()
    .map((f) => `${TOOLS_DIR}/${f}`),
  'server/mcp/cloudMemo.ts',
];

/** The text with its comments blanked out (same length, lines kept), so a header may name what the code never does. */
const code = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])(\/\/.*)$/gm, (_m, before: string, comment: string) => before + ' '.repeat(comment.length));

/**
 * `text` (comments already blanked) with what its string, template and regex literals hold blanked out too, same length:
 * a word in a description or a pattern is no code. A template's `${…}` stays code.
 */
function bare(text: string): string {
  let out = '';
  let i = 0;
  /** The brace depth inside each open `${`. */
  const holes: number[] = [];
  const blank = (from: number): void => {
    out += text.slice(from, i).replace(/[^\n]/g, ' ');
  };
  const quoted = (q: string): void => {
    const from = i;
    i += 1;
    while (i < text.length && text[i] !== q && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    i = Math.min(i + 1, text.length);
    blank(from);
  };
  /** From `from` (a backtick, or a `${…}`'s closing brace) to the template's end or its next `${`, blanked. */
  const template = (from: number): void => {
    i = from + 1;
    while (i < text.length) {
      if (text[i] === '\\') {
        i += 2;
      } else if (text[i] === '`') {
        i += 1;
        blank(from);
        return;
      } else if (text[i] === '$' && text[i + 1] === '{') {
        i += 2;
        blank(from);
        holes.push(0);
        return;
      } else {
        i += 1;
      }
    }
    blank(from);
  };
  const regexMayStart = (): boolean => {
    const before = out.trimEnd();
    return before === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|in|of)$/.test(before);
  };
  const regex = (): void => {
    const from = i;
    let inClass = false;
    i += 1;
    while (i < text.length && text[i] !== '\n') {
      const c = text[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) break;
      i += 1;
    }
    i += 1;
    while (/[a-z]/i.test(text[i] ?? '')) i += 1;
    blank(from);
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') {
      quoted(c);
    } else if (c === '`') {
      template(i);
    } else if (c === '/' && regexMayStart()) {
      regex();
    } else if (holes.length > 0 && c === '}' && holes[holes.length - 1] === 0) {
      holes.pop();
      template(i);
    } else {
      if (holes.length > 0 && c === '{') holes[holes.length - 1] += 1;
      if (holes.length > 0 && c === '}') holes[holes.length - 1] -= 1;
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * The module specifiers a source imports or re-exports for their values, static or dynamic (any quote): a type-only
 * import (`import type`, or every name marked `type`) is erased, so it is no path out.
 */
function specifiers(text: string): string[] {
  const t = code(text);
  const found: string[] = [];
  for (const m of t.matchAll(/^\s*(?:import|export)\s+(type\s+)?([^;()=]*?)\s*\bfrom\s*(['"`])([^'"`]+)\3/gm)) {
    if (m[1] !== undefined) continue;
    const named = /^\{([\s\S]*)\}$/.exec(m[2].trim());
    const names = named === null ? [] : named[1].split(',').map((s) => s.trim()).filter((s) => s !== '');
    if (names.length > 0 && names.every((s) => s.startsWith('type '))) continue;
    found.push(m[4]);
  }
  for (const m of t.matchAll(/^\s*import\s*(['"`])([^'"`]+)\1/gm)) found.push(m[2]);
  for (const m of t.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) found.push(m[2]);
  for (const m of t.matchAll(/\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g)) found.push(m[2]);
  return found;
}

/** What a P6 module and what it imports may take from outside the repo. */
const ALLOWED: ReadonlySet<string> = new Set(['zod', 'node:crypto', 'node:os', 'node:path']);

/** What a P6 module's code never names (literals and comments blanked). */
const BANNED_WORDS = /\b(?:fetch|globalThis|process|require|createRequire|getBuiltinModule|eval|Function|WebSocket|XMLHttpRequest)\b/;

/** A dynamic import of anything but a relative module, a literal one. */
const DYNAMIC_IMPORT = /\bimport\s*\((?!\s*['"]\.\.?\/[^'"]*['"]\s*\))/;

/** The repo file a relative specifier of `from` names (the `.js` of an ESM import is the `.ts`/`.tsx` on disk). */
function resolveRelative(from: string, spec: string): string {
  const base = resolve(join(ROOT, dirname(from)), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, join(base, 'index.ts')];
  const found = candidates.find((p) => existsSync(p)) ?? candidates[0];
  return relative(ROOT, found);
}

/** Every module `rel` reaches through value imports, itself first, and each one's outside specifiers. */
function closure(rel: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [rel];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    const specs = specifiers(source(next));
    seen.set(next, specs.filter((s) => !s.startsWith('.')));
    for (const s of specs) if (s.startsWith('.')) queue.push(resolveRelative(next, s));
  }
  return seen;
}

describe('no P6 module reaches past AASC’s own routes', () => {
  it('the P6 modules are found by their names: the core’s, every chunk’s, and the memo', () => {
    for (const rel of ['cloudWrite.ts', 'cloudJob.ts', 'cloudJobs.ts', 'cloudSync.ts', 'cloudPublish.ts', 'cloudP6.ts']) {
      expect(P6_MODULES).toContain(`${TOOLS_DIR}/${rel}`);
    }
    expect(P6_MODULES).toContain('server/mcp/cloudMemo.ts');
    expect(P6_MODULES.some((rel) => P1_CLOUD.has(rel.slice(TOOLS_DIR.length + 1)))).toBe(false);
  });

  it('the check itself catches each way out', () => {
    const bad = [
      "import { readFile } from 'node:fs/promises';",
      "import { spawn } from 'child_process';",
      "const net = await import('node:net');",
      'const fs = await import(`node:fs`);',
      "import 'node:https';",
      "import { git } from '../../cloud/git.js';",
      "import { request } from 'undici';",
      "import { createRequire } from 'node:module';",
      "import { runInNewContext } from 'vm';",
      "import { Worker } from 'node:worker_threads';",
    ].join('\n');
    const imports = specifiers(bad);

    expect(imports.filter((s) => !s.startsWith('.') && !ALLOWED.has(s)).sort()).toEqual([
      'child_process',
      'node:fs',
      'node:fs/promises',
      'node:https',
      'node:module',
      'node:net',
      'node:worker_threads',
      'undici',
      'vm',
    ]);
    expect(imports.filter((s) => /(?:^|\/)cloud\//.test(s))).toEqual(['../../cloud/git.js']);
    for (const line of [
      'const r = await fetch(url);',
      'const f = globalThis.fetch;',
      'const get = fetch;',
      "const fs = process.getBuiltinModule('fs');",
      'const req = createRequire(import.meta.url);',
      "const m = require('fs');",
      'const f = new Function("return 1");',
    ]) {
      expect(bare(code(line)), line).toMatch(BANNED_WORDS);
    }
    expect(code('const m = await import(name);')).toMatch(DYNAMIC_IMPORT);
    expect(code('const m = await import(`node:${"fs"}`);')).toMatch(DYNAMIC_IMPORT);
    expect(code("const { remoteViewOf } = await import('./cloud.js');")).not.toMatch(DYNAMIC_IMPORT);
  });

  it('the check reads words in text and patterns as no code, and a type-only import as no path', () => {
    const fine = [
      "const hint = 'as of the last fetch.';",
      'const said = `the process ${n} of fetch`;',
      'const EMAIL = /^[^\\s@<>"\'`]{1,64}@[^\\s@<>"\'`]{1,190}$/;',
      'const after = fetched;',
      '// fetch(url) is never called here',
      "import type { InternalResponse } from '../client.js';",
      "import { type ToolDef, type Risk } from '../registry.js';",
      "export type { Thing } from '../thing.js';",
    ].join('\n');

    expect(bare(code(fine))).not.toMatch(BANNED_WORDS);
    expect(specifiers(fine)).toEqual([]);
    // A template's code is still code.
    expect(bare(code('const s = `${fetch(u)}`;'))).toMatch(BANNED_WORDS);
  });

  it.each(P6_MODULES)('%s, and every module it imports for its values', (rel) => {
    for (const [mod, outside] of closure(rel)) {
      expect(outside.filter((s) => !ALLOWED.has(s)), `${mod} (reached from ${rel})`).toEqual([]);
      expect(mod, `reached from ${rel}`).not.toMatch(/^server\/cloud\//);
    }
    const text = code(source(rel));
    expect(bare(text)).not.toMatch(BANNED_WORDS);
    expect(text).not.toMatch(DYNAMIC_IMPORT);
  });
});

// ---------------------------------------------------------------------------
// The account a waiting tool's run acts as (P6-6)
// ---------------------------------------------------------------------------

/** The P6 tools that wait for the person (WAITS_FOR_PERSON: ask, outward, destructive). */
const waitingTools = (): ToolDef[] => cloudP6Tools.filter((t) => WAITS_FOR_PERSON.has(t.risk));

/** The body of `run` of the tool named `name` in `rel` (literals and comments blanked), or null. */
function runBodyOf(rel: string, name: string): string | null {
  const text = code(source(rel));
  const b = bare(text);
  const at = text.search(new RegExp(`\\bname:\\s*['"]${name}['"]`));
  if (at < 0) return null;
  const nextTool = b.indexOf('defineTool(', at);
  const runAt = b.indexOf('async run(', at);
  if (runAt < 0 || (nextTool >= 0 && runAt > nextTool)) return null;
  const open = b.indexOf('{', b.indexOf(')', runAt));
  let depth = 0;
  for (let i = open; i < b.length; i += 1) {
    if (b[i] === '{') depth += 1;
    if (b[i] === '}') depth -= 1;
    if (depth === 0) return b.slice(open, i + 1);
  }
  return null;
}

describe('only cloudWrite.ts names the live binding', () => {
  it.each(P6_MODULES.filter((rel) => !rel.endsWith('cloudWrite.ts')))('%s never names boundTo or boundGet', (rel) => {
    expect(bare(code(source(rel)))).not.toMatch(/\bbound(?:To|Get)\b/);
  });

  it('cloudWrite.ts names boundTo only inside liveAccount', () => {
    const text = code(source('server/mcp/tools/cloudWrite.ts'));
    const uses = [...text.matchAll(/\bbound(?:To|Get)\b/g)].length;
    const live = /export async function liveAccount\([^)]*\)[^{]*\{[^}]*\bboundTo\(ctx\)[^}]*\}/.exec(text);

    expect(live).not.toBeNull();
    // The import, and the one call in liveAccount.
    expect(uses).toBe(2);
  });

  it.each(waitingTools().map((t) => t.name))('the run of %s names approvedAccount and never a live read of the account', (name) => {
    const bodies = P6_MODULES.map((rel) => runBodyOf(rel, name)).filter((b): b is string => b !== null);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/\bapprovedAccount\(ctx\)/);
    expect(bodies[0]).not.toMatch(/\b(?:liveAccount|reviewAccount|cloudStatus|readStatus|boundTo|boundGet)\b/);
  });

  it('the run-body reader finds a body and what it names', () => {
    const body = runBodyOf('server/mcp/tools/cloudJobs.ts', 'cloud_job_cancel');

    expect(body).toMatch(/\bliveAccount\(ctx\)/);
    expect(body?.startsWith('{')).toBe(true);
    expect(body?.endsWith('}')).toBe(true);
  });
});

const KEY_A = `${BACKEND}|${ACCOUNT}|3`;
const PLAN = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';
const JOB = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
const FOLDER = join(homedir(), 'code', 'demo');
const REPOSITORY = { provider: 'github', owner: 'octo', name: 'demo', url: 'https://github.com/octo/demo', branch: 'main' };
const RECORD = { id: PROJECT_ID, version: 3, name: 'demo', repository: REPOSITORY, description: '', resources: [], deleted: false };

interface WaitingCase {
  args: Record<string, unknown>;
  /** Routes its `confirm` reads (only for a case that is reviewed through its own confirm). */
  routes?: Record<string, Answer>;
  /** What this central holds before the call (its own plan). */
  seed?: () => void;
  /**
   * Reviewed through the tool's own `confirm` (it keeps what its run sends on the call's context); otherwise through
   * `reviewAccount` alone, all such a run reads.
   */
  viaConfirm?: boolean;
}

/** Every waiting P6 tool, with arguments its run gets past its own checks with (a new one fails the first test). */
const WAITING: Readonly<Record<string, WaitingCase>> = {
  cloud_sync_now: { args: {} },
  cloud_publish_run: { args: { planId: PLAN } },
  cloud_install_run: {
    args: { planId: PLAN },
    seed: () => rememberPlan('central-1', { kind: 'install', planId: PLAN, accountKey: KEY_A, plan: { id: PLAN, items: [] }, at: NOW }),
  },
  cloud_job_retry: { args: { jobId: JOB } },
  cloud_project_create: {
    args: { folder: FOLDER },
    routes: { 'GET /resources/cloud/projects/candidates': envelope({ items: [{ path: FOLDER, repository: REPOSITORY, projectId: null }] }) },
    viaConfirm: true,
  },
  cloud_project_update: {
    args: { id: PROJECT_ID, name: 'renamed' },
    routes: { [`GET /resources/cloud/projects/${PROJECT_ID}`]: envelope(RECORD) },
    viaConfirm: true,
  },
  cloud_project_remove: { args: { id: PROJECT_ID } },
  cloud_project_push: { args: { id: PROJECT_ID } },
  cloud_project_retry_resources: { args: { jobId: JOB } },
};

const caseOf = (name: string): WaitingCase => {
  const found = WAITING[name];
  if (found === undefined) throw new Error(`No case for ${name}`);
  return found;
};

const parsedArgs = async (tool: ToolDef, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await z.object(tool.input).parseAsync(args)) as Record<string, unknown>;

const failureOf = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

describe('what the run of every waiting P6 tool acts as', () => {
  afterEach(() => {
    resetCloudMemo();
    resetCloudBudget();
  });

  it('every waiting P6 tool has a case here', () => {
    expect(waitingTools().map((t) => t.name).sort()).toEqual(Object.keys(WAITING).sort());
  });

  it.each(waitingTools().map((t) => [t.name, t] as const))(
    '%s: the person’s allow with no review of this call behind it is INVALID and calls nothing',
    async (name, tool) => {
      const c = caseOf(name);
      c.seed?.();
      const h = cloudCtx({ allowedByPerson: () => true, routes: c.routes });

      const err = await failureOf(tool.run(await parsedArgs(tool, c.args), h.ctx));

      expect(err.code).toBe('INVALID');
      expect(h.client.calls).toEqual([]);
    },
  );

  it.each(waitingTools().map((t) => [t.name, t] as const))(
    '%s: reviewed as A, then switched to B, its run reads no status and names A in every call',
    async (name, tool) => {
      const c = caseOf(name);
      c.seed?.();
      const h = cloudCtx({ allowedByPerson: () => true, routes: c.routes });
      const args = await parsedArgs(tool, c.args);
      if (c.viaConfirm === true) await tool.confirm?.(args, h.ctx);
      else await reviewAccount(h.ctx);
      switchAccount(h, 'B');
      const before = h.client.calls.length;

      // The routes answer 404 past the review: what matters is what the run asked, and as whom.
      await tool.run(args, h.ctx).catch(() => undefined);
      const made = h.client.calls.slice(before);

      expect(made.length, 'the run made no call: its case no longer gets past its own checks').toBeGreaterThan(0);
      expect(made.filter((call) => call.path === STATUS_PATH.slice('GET '.length))).toEqual([]);
      for (const call of made) expect([CLOUD_HEADERS, NOTES_HEADERS], `${call.method} ${call.path}`).toContainEqual(call.headers);
    },
  );
});

describe('cloudTools ends with cloudP6Tools', () => {
  it('cloudTools ends with cloudP6Tools, and every tool there says phase 6 and toolset cloud', () => {
    const tail = cloudTools.slice(cloudTools.length - cloudP6Tools.length);

    expect(tail).toEqual(cloudP6Tools);
    expect(cloudTools.slice(0, cloudTools.length - cloudP6Tools.length).every((t) => t.phase === 1)).toBe(true);
    for (const tool of cloudP6Tools) {
      expect(tool.phase, tool.name).toBe(6);
      expect(tool.toolset, tool.name).toBe('cloud');
    }
  });

  it('every P6 tool’s name is unique among all the cloud tools', () => {
    const names = cloudTools.map((t) => t.name);

    expect(new Set(names).size).toBe(names.length);
  });
});

describe('the P1 view builders', () => {
  it('remoteViewOf and localOf answer what remote_access_get and cloud_project_local answered', async () => {
    for (const body of [REMOTE_VIEW, {}, { tailscale: 'x', phones: [{ platform: 'win' }] }]) {
      const { ctx } = makeCtx({ routes: { 'GET /resources/cloud/remote-access': envelope(body) } });
      const viaTool = await run('remote_access_get', {}, ctx);
      expect(remoteViewOf(body)).toEqual({ data: viaTool.data, summary: viaTool.summary });
    }
    for (const body of [LOCAL_MAIN('ahead'), LOCAL_MAIN('missing'), LOCAL_BRANCH('ready'), { state: 'Weird state!' }]) {
      const { ctx, client } = makeCtx({
        routes: { [STATUS_PATH]: connectedStatus, [`GET /resources/cloud/projects/${PROJECT_ID}/local`]: envelope(body) },
      });
      const viaTool = await run('cloud_project_local', { id: PROJECT_ID }, ctx);
      expect(client.calls[1]).toMatchObject({ headers: CLOUD_HEADERS });
      expect(localOf(PROJECT_ID, body)).toEqual({ data: viaTool.data, summary: viaTool.summary });
    }
  });
});
