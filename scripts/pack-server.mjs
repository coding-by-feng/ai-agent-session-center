#!/usr/bin/env node
/**
 * pack-server.mjs — the headless server package, `ai-agent-session-center` with one command,
 * `aasc-server` (terminal-editions plan §6.2, §6.4).
 *
 *   npm run pack:server     vite build + build:server, then this script:
 *     1. bundle cli/server → dist/cli/admin.cjs
 *     2. stage dist/pack/server/: bin/, hooks/, scripts/set-password.mjs, the two bundles, dist/client/
 *        and a GENERATED package.json whose dependencies are exactly the bundles' require()s
 *     3. npm pack → dist/pack/ai-agent-session-center-<version>.tgz   (--dry-run lists the files only)
 *
 *   node scripts/pack-server.mjs --bundle-deps     the release tarball (P4.1, CI's Linux runner):
 *     after step 2, `npm install --omit=dev` in the staged folder, so the tarball carries
 *     better-sqlite3 and node-pty compiled for THIS Node. better-sqlite3 loads only on the major it was
 *     compiled for, so engines is pinned to it (>=22.12.0 <23) and the name says it:
 *     dist/pack/ai-agent-session-center-<version>-node22-linux-x64.tgz, plus its .sha256 beside it.
 *     scripts/install-server.sh installs that pair.
 *
 * The build fails when a bundle requires a package outside SERVER_DEPENDENCIES, or one the root
 * package.json doesn't declare: the server package must not install the desktop's ≈ 454 MB of
 * node_modules. A new server dependency is added to the allow-list on purpose.
 *
 * static/ is not shipped: it is Vite's publicDir, already copied into dist/client.
 */
import { build } from 'esbuild';
import { execFileSync } from 'child_process';
import { builtinModules } from 'module';
import { createHash } from 'crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/** Every package the server and admin bundles may require; anything else fails the build. */
export const SERVER_DEPENDENCIES = new Set([
  '@modelcontextprotocol/sdk', '@xterm/headless', 'better-sqlite3', 'diff', 'express', 'node-pty',
  'smol-toml', 'ws', 'yaml', 'yazl', 'zod',
]);

/** Named in the error even if someone adds one to the allow-list: these are the desktop's weight. */
export const FORBIDDEN_DEPENDENCIES = [/^react$/, /^react-dom$/, /^three$/, /^@react-three\//, /^electron$/, /^tsx$/];

/** dist/cli/admin.cjs: the admin commands, built like the server bundle (packages stay external). */
export const adminBuildOptions = {
  entryPoints: ['cli/server/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  outfile: 'dist/cli/admin.cjs',
  banner: {
    js: 'var __importMetaUrl = require("url").pathToFileURL(__filename).href;',
  },
  define: {
    'import.meta.url': '__importMetaUrl',
  },
};

const BUILTINS = new Set(builtinModules);

/** The npm package a specifier loads, or null for a builtin or a path. */
export function packageNameOf(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return BUILTINS.has(name) ? null : name;
}

/** Every package a bundle loads with a literal require("…") or import("…"). */
export function externalPackages(code) {
  const found = new Set();
  for (const match of code.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) {
    const name = packageNameOf(match[1]);
    if (name) found.add(name);
  }
  return found;
}

/** The generated package.json, and why it can't be used (empty when it can). */
export function buildServerManifest(rootPkg, packages) {
  const errors = [];
  const dependencies = {};
  for (const name of [...packages].sort()) {
    if (FORBIDDEN_DEPENDENCIES.some((re) => re.test(name))) {
      errors.push(`${name} must not be a dependency of the server package (a bundle requires it)`);
      continue;
    }
    if (!SERVER_DEPENDENCIES.has(name)) {
      errors.push(`${name} is required by a bundle but is not on the server package's allow-list (SERVER_DEPENDENCIES in scripts/pack-server.mjs)`);
      continue;
    }
    const version = rootPkg.dependencies?.[name];
    if (!version) {
      errors.push(`${name} is required by a bundle but not declared in the root package.json dependencies`);
      continue;
    }
    dependencies[name] = version;
  }
  const manifest = {
    name: rootPkg.name,
    version: rootPkg.version,
    description: 'AI Agent Session Center — headless server for Linux: monitor and drive Claude Code and Codex sessions from a browser, the desktop app or a phone',
    type: 'module',
    bin: { 'aasc-server': 'bin/cli.js' },
    engines: rootPkg.engines,
    keywords: rootPkg.keywords,
    author: rootPkg.author,
    license: rootPkg.license,
    repository: rootPkg.repository,
    dependencies,
  };
  return { manifest, errors };
}

function copyInto(from, to) {
  cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => !/\.test\.[cm]?[jt]sx?$/.test(src) && !src.includes('__tests__'),
  });
}

/**
 * Stage the package in `out` from the built files under `root`. Expects dist/server-bundle.cjs,
 * dist/cli/admin.cjs and dist/client/ to exist. Throws when the manifest has errors.
 */
export function stageServerPackage({ root = ROOT, out }) {
  const bundles = [join(root, 'dist', 'server-bundle.cjs'), join(root, 'dist', 'cli', 'admin.cjs')];
  for (const file of [...bundles, join(root, 'dist', 'client', 'index.html')]) {
    if (!existsSync(file)) throw new Error(`${file} is missing: run npm run pack:server, which builds it first`);
  }
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packages = new Set();
  for (const file of bundles) for (const name of externalPackages(readFileSync(file, 'utf8'))) packages.add(name);
  const { manifest, errors } = buildServerManifest(rootPkg, packages);
  if (errors.length > 0) throw new Error(`the server package can't be built:\n  ${errors.join('\n  ')}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'dist', 'cli'), { recursive: true });
  mkdirSync(join(out, 'scripts'), { recursive: true });
  copyInto(join(root, 'bin'), join(out, 'bin'));
  copyInto(join(root, 'hooks'), join(out, 'hooks'));
  copyInto(join(root, 'scripts', 'set-password.mjs'), join(out, 'scripts', 'set-password.mjs'));
  copyInto(bundles[0], join(out, 'dist', 'server-bundle.cjs'));
  copyInto(bundles[1], join(out, 'dist', 'cli', 'admin.cjs'));
  copyInto(join(root, 'dist', 'client'), join(out, 'dist', 'client'));
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest };
}

/**
 * The engines range for a tarball whose native modules were compiled on `nodeVersion`: that major
 * only, never below the root's own minimum. Throws when this Node is below the minimum.
 */
export function pinEnginesToMajor(range, nodeVersion) {
  const min = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!min) throw new Error(`engines.node must be a plain ">=x.y.z" range to pin, not "${range}"`);
  const [major, minor, patch] = nodeVersion.split('.').map(Number);
  const floor = min.slice(1).map(Number);
  const below = major !== floor[0] ? major < floor[0] : minor !== floor[1] ? minor < floor[1] : patch < floor[2];
  if (below) throw new Error(`Node ${nodeVersion} is below engines ${range}: build the release tarball on a supported Node`);
  const lower = major === floor[0] ? floor.join('.') : `${major}.0.0`;
  return `>=${lower} <${major + 1}`;
}

/** The --bundle-deps manifest: engines pinned to this Node's major, every dependency bundled. */
export function bundledManifest(manifest, nodeVersion) {
  return {
    ...manifest,
    engines: { ...manifest.engines, node: pinEnginesToMajor(manifest.engines.node, nodeVersion) },
    bundleDependencies: Object.keys(manifest.dependencies),
  };
}

export function bundledTarballName(manifest, nodeVersion, platform, arch) {
  return `${manifest.name}-${manifest.version}-node${nodeVersion.split('.')[0]}-${platform}-${arch}.tgz`;
}

/** The files `npm pack` would put in the tarball, relative to the package root. */
export function packedFiles(out) {
  const json = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: out, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(json)[0].files.map((f) => f.path).sort();
}

/**
 * Install the production dependencies into the staged folder, with install scripts (they compile or
 * fetch the native modules for this Node). The root lockfile is copied in so the versions match the
 * desktop's, then removed: the tarball carries node_modules, not a lockfile for another package.
 */
function installBundledDeps(out) {
  const lock = join(out, 'package-lock.json');
  copyFileSync(join(ROOT, 'package-lock.json'), lock);
  try {
    execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' });
  } finally {
    rmSync(lock, { force: true });
  }
}

function packBundled(out, manifest) {
  const packDir = join(ROOT, 'dist', 'pack');
  installBundledDeps(out);
  const bundled = bundledManifest(manifest, process.versions.node);
  writeFileSync(join(out, 'package.json'), `${JSON.stringify(bundled, null, 2)}\n`);
  for (const old of readdirSync(packDir)) if (old.endsWith('.tgz') || old.endsWith('.tgz.sha256')) rmSync(join(packDir, old));
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: out, stdio: ['ignore', 'ignore', 'inherit'] });
  const name = bundledTarballName(bundled, process.versions.node, process.platform, process.arch);
  renameSync(join(packDir, `${bundled.name}-${bundled.version}.tgz`), join(packDir, name));
  const sha = createHash('sha256').update(readFileSync(join(packDir, name))).digest('hex');
  // The `sha256sum -c` format: install-server.sh reads the first field.
  writeFileSync(join(packDir, `${name}.sha256`), `${sha}  ${name}\n`);
  process.stdout.write(`✓ ${join(packDir, name)}\n  sha256 ${sha}\n`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const bundleDeps = process.argv.includes('--bundle-deps');
  await build({ ...adminBuildOptions, absWorkingDir: ROOT, logLevel: 'warning' });
  const out = join(ROOT, 'dist', 'pack', 'server');
  const { manifest } = stageServerPackage({ root: ROOT, out });
  const files = packedFiles(out);
  process.stdout.write(`✓ staged ${out}: ${files.length} files, ${Object.keys(manifest.dependencies).length} dependencies\n`);
  process.stdout.write(`  ${Object.keys(manifest.dependencies).join(', ')}\n`);
  if (dryRun) return;
  if (bundleDeps) {
    packBundled(out, manifest);
    return;
  }
  const packDir = join(ROOT, 'dist', 'pack');
  for (const old of readdirSync(packDir)) if (old.endsWith('.tgz')) rmSync(join(packDir, old));
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], { cwd: out, stdio: ['ignore', 'ignore', 'inherit'] });
  const tgz = readdirSync(packDir).find((f) => f.endsWith('.tgz'));
  process.stdout.write(`✓ ${join(packDir, tgz)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
