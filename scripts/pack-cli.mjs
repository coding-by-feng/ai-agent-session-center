/**
 * Builds the `aasc` terminal client package (terminal editions plan §6.3–§6.4):
 *
 *   esbuild cli/client (+ ws, zod, the shared remote client) ──▶ dist/pack/cli/bin/aasc.cjs
 *   a package.json with no dependencies                       ──▶ dist/pack/cli/package.json
 *   npm pack                                                  ──▶ dist/pack/aasc-<version>.tgz
 *
 * ws is bundled rather than using Node's built-in WebSocket, which can't send an
 * Authorization header. Its optional native add-ons (bufferutil, utf-8-validate) are
 * replaced by modules that throw on load, so ws takes its pure-JS path exactly as it does
 * when they aren't installed.
 *
 * Fails the build when the bundle require()s anything outside Node's built-ins.
 *
 *   node scripts/pack-cli.mjs [--no-pack]
 */
import { build } from 'esbuild';
import { builtinModules } from 'module';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist', 'pack', 'cli');
const BIN = join(OUT_DIR, 'bin', 'aasc.cjs');
/** The npm name (plan Q6). If it's taken at publish time, the fallback is `aasc-cli`. */
const PACKAGE_NAME = 'aasc';
const OPTIONAL_NATIVE = /^(bufferutil|utf-8-validate)$/;

const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** ws's optional native helpers: throw on load, so ws's own try/catch falls back to pure JS. */
const stubOptionalNative = {
  name: 'stub-optional-native',
  setup(b) {
    b.onResolve({ filter: OPTIONAL_NATIVE }, (args) => ({ path: args.path, namespace: 'optional-native' }));
    b.onLoad({ filter: /.*/, namespace: 'optional-native' }, (args) => ({
      contents: `throw new Error(${JSON.stringify(`${args.path} is not bundled with aasc`)});`,
      loader: 'js',
    }));
  },
};

/** esbuild options for the `aasc` bundle; test/packCliBundle.test.ts builds with these too. */
export function cliBuildOptions(overrides = {}) {
  return {
    entryPoints: [join(ROOT, 'cli', 'client', 'bin.ts')],
    outfile: BIN,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    minify: false,
    legalComments: 'inline',
    banner: { js: '#!/usr/bin/env node' },
    define: { __AASC_VERSION__: JSON.stringify(root.version) },
    plugins: [stubOptionalNative],
    logLevel: 'warning',
    ...overrides,
  };
}

/** Every module the bundle require()s that isn't a Node built-in (`electron` included): must be empty. */
export function nonBuiltinRequires(bundleText) {
  const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
  const required = new Set([...bundleText.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
  return { required: [...required].sort(), outside: [...required].filter((m) => !builtins.has(m)) };
}

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(dirname(BIN), { recursive: true });
  await build(cliBuildOptions());
  chmodSync(BIN, 0o755);

  // The dependency guard: every require() must be a Node built-in.
  const bundle = readFileSync(BIN, 'utf8');
  const { required, outside } = nonBuiltinRequires(bundle);
  if (outside.length) {
    console.error(`✕ ${BIN} requires modules outside Node's built-ins: ${outside.join(', ')}`);
    process.exit(1);
  }

  const manifest = {
    name: PACKAGE_NAME,
    version: root.version,
    description: 'The AASC terminal client: list, attach to, send to and watch AI agent sessions on an AASC server.',
    license: root.license,
    repository: root.repository,
    bin: { aasc: 'bin/aasc.cjs' },
    files: ['bin'],
    engines: { node: '>=22.12' },
  };
  writeFileSync(join(OUT_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ ${BIN} (${Math.round(bundle.length / 1024)} KB; requires only: ${required.join(', ')})`);

  if (!process.argv.includes('--no-pack')) {
    const tgz = execFileSync('npm', ['pack', '--pack-destination', join(ROOT, 'dist', 'pack')], {
      cwd: OUT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    }).trim().split('\n').at(-1);
    console.log(`✓ dist/pack/${tgz}`);
  }
}

// Run only when called directly (node scripts/pack-cli.mjs), not when a test imports it.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
