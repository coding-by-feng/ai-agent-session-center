// The npm package must contain every file its server, CLI and hooks import.
//
// 2.10.40 shipped without src/: server/sshManager.ts value-imports ../src/types/terminal.js (and
// other server modules import src/lib/*), so `npx ai-agent-session-center` died with
// ERR_MODULE_NOT_FOUND while every run from a checkout worked. This test asks npm itself what it
// would pack (`npm pack --dry-run`, which honours package.json `files` and .npmignore), then walks
// the relative imports from the packed entry points and requires each one to be in the tarball.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  files: string[];
  engines?: { node?: string };
  scripts: Record<string, string>;
};

let packed: Set<string>;

beforeAll(() => {
  // --ignore-scripts: no prepack build in a unit test; dist/client is checked by the publish smoke test.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const [info] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  packed = new Set(info.files.map((f) => f.path));
}, 120_000);

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]|(?:^|[\s;(])import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;(=])require\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** The file a relative specifier loads, the way tsx resolves it (`./x.js` may be `./x.ts`). */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(path.join(ROOT, fromFile)), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.js`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.js'),
  ];
  const hit = candidates.find((c) => existsSync(c) && statSync(c).isFile());
  return hit ? path.relative(ROOT, hit) : null;
}

/** Every file reachable through relative imports from the packed server, CLI and hook files. */
function runtimeClosure(): { reached: Set<string>; unresolved: string[] } {
  const queue = [...packed].filter((f) => /^(server|bin|hooks)\//.test(f) && /\.(ts|js|cjs|mjs)$/.test(f));
  const reached = new Set<string>(queue);
  const unresolved: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec?.startsWith('.')) continue;
      const target = resolveRelative(file, spec);
      if (!target) {
        unresolved.push(`${file} -> ${spec}`);
        continue;
      }
      if (!reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return { reached, unresolved };
}

describe('npm package contents', () => {
  it('packs every file the server, CLI and hooks import', () => {
    const { reached, unresolved } = runtimeClosure();
    expect(unresolved).toEqual([]);
    const missing = [...reached].filter((f) => !packed.has(f)).sort();
    expect(missing).toEqual([]);
  });

  it('packs the shared src/ modules the server imports at runtime', () => {
    // The two that broke 2.10.40, named so a regression reads plainly.
    expect(packed.has('src/types/terminal.ts')).toBe(true);
    expect(packed.has('src/lib/ansi.ts')).toBe(true);
  });

  it('ships no tests from src/', () => {
    expect([...packed].filter((f) => f.startsWith('src/') && /\.test\.|__tests__/.test(f))).toEqual([]);
  });

  it('lists no `files` entry that matches nothing', () => {
    // dist/ is a build output (prepack creates it), so only source roots must exist in a checkout.
    const roots = pkg.files.filter((f) => !f.startsWith('!')).map((f) => f.split('/')[0]);
    expect(roots.filter((r) => r !== 'dist' && !existsSync(path.join(ROOT, r)))).toEqual([]);
  });

  it('builds the client before packing, so dist/client is never stale or missing', () => {
    expect(pkg.scripts.prepack).toMatch(/\bnpm run build\b/);
  });

  it('asks for the Node version the native modules and the README need', () => {
    expect(pkg.engines?.node).toBe('>=22.12.0');
  });
});
