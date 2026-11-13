// test/packServerManifest.test.ts — the headless server package (scripts/pack-server.mjs, plan §6.2, §6.4).
//
// The bundles are built from the real sources into a temporary root (never the checkout's dist/, which
// headlessStart.test.ts builds at the same time), staged into a temporary folder, and listed with
// `npm pack --dry-run`. Nothing is installed or published.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { serverBuildOptions } from '../scripts/build-server.mjs';
import {
  SERVER_DEPENDENCIES, FORBIDDEN_DEPENDENCIES, packageNameOf, externalPackages, buildServerManifest, adminBuildOptions,
  stageServerPackage, packedFiles, pinEnginesToMajor, bundledManifest, bundledTarballName,
} from '../scripts/pack-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('packageNameOf / externalPackages', () => {
  it('reduces a specifier to its package, and drops builtins and relative paths', () => {
    expect(packageNameOf('express')).toBe('express');
    expect(packageNameOf('@modelcontextprotocol/sdk/server/mcp.js')).toBe('@modelcontextprotocol/sdk');
    expect(packageNameOf('yaml/util')).toBe('yaml');
    expect(packageNameOf('node:fs')).toBeNull();
    expect(packageNameOf('fs/promises')).toBeNull();
    expect(packageNameOf('./x.js')).toBeNull();
    expect(packageNameOf('/abs')).toBeNull();
  });

  it('finds every require() and dynamic import() of a package', () => {
    const code = [
      'var a = require("express");',
      "var b = require('@xterm/headless');",
      'var c = require("node:path"); var d = require("fs");',
      'var e = require("./local");',
      'const f = await import("yaml");',
      'require(someVariable);',
    ].join('\n');
    expect([...externalPackages(code)].sort()).toEqual(['@xterm/headless', 'express', 'yaml']);
  });
});

describe('buildServerManifest', () => {
  it('lists exactly the packages the bundles need, at the root versions, with one aasc-server command', () => {
    const { manifest, errors } = buildServerManifest(rootPkg, new Set(['express', 'zod']));
    expect(errors).toEqual([]);
    expect(manifest.name).toBe('ai-agent-session-center');
    expect(manifest.version).toBe(rootPkg.version);
    expect(manifest.bin).toEqual({ 'aasc-server': 'bin/cli.js' });
    expect(manifest.engines).toEqual(rootPkg.engines);
    expect(manifest.type).toBe('module');
    expect(manifest.dependencies).toEqual({ express: rootPkg.dependencies.express, zod: rootPkg.dependencies.zod });
    expect(manifest.devDependencies).toBeUndefined();
    expect(manifest.scripts).toBeUndefined();
  });

  it('allows only the server packages: any other frontend package fails, declared or not', () => {
    expect([...SERVER_DEPENDENCIES].sort()).toEqual([
      '@modelcontextprotocol/sdk', '@xterm/headless', 'better-sqlite3', 'diff', 'express', 'node-pty',
      'smol-toml', 'ws', 'yaml', 'yazl', 'zod',
    ]);
    for (const name of ['dexie', 'zustand', '@tanstack/react-query', 'pdfjs-dist', 'xlsx']) {
      expect(rootPkg.dependencies[name], name).toBeDefined();
      expect(buildServerManifest(rootPkg, new Set([name])).errors.join('\n')).toMatch(new RegExp(`${name.replace('/', '\\/')}.*allow-list`));
    }
  });

  it('fails on a package the root does not declare', () => {
    expect(buildServerManifest(rootPkg, new Set(['left-pad'])).errors.join('\n')).toMatch(/left-pad/);
  });

  it('fails on a frontend or desktop package', () => {
    for (const name of ['react', 'react-dom', 'three', '@react-three/fiber', 'electron', 'tsx']) {
      const fake = { ...rootPkg, dependencies: { ...rootPkg.dependencies, [name]: '1.0.0' } };
      expect(buildServerManifest(fake, new Set([name])).errors.join('\n')).toMatch(new RegExp(`${name.replace('/', '\\/')}.*must not`));
    }
    expect(FORBIDDEN_DEPENDENCIES.length).toBeGreaterThan(0);
  });
});

describe('--bundle-deps (the release tarball with compiled native modules, P4.1)', () => {
  it('pins engines to the Node major the native modules were compiled for', () => {
    expect(pinEnginesToMajor('>=22.12.0', '22.14.0')).toBe('>=22.12.0 <23');
    expect(pinEnginesToMajor('>=22.12.0', '22.12.0')).toBe('>=22.12.0 <23');
    expect(pinEnginesToMajor('>=22.12.0', '24.1.0')).toBe('>=24.0.0 <25');
    expect(() => pinEnginesToMajor('>=22.12.0', '22.11.0')).toThrow(/22\.11\.0.*>=22\.12\.0/);
    expect(() => pinEnginesToMajor('>=22.12.0', '20.18.0')).toThrow();
    expect(() => pinEnginesToMajor('^22', '22.14.0')).toThrow(/>=/);
  });

  it('rewrites engines and bundles every dependency, leaving the rest of the manifest alone', () => {
    const { manifest } = buildServerManifest(rootPkg, new Set(['express', 'zod']));
    const bundled = bundledManifest(manifest, '22.14.0');
    expect(bundled).toEqual({ ...manifest, engines: { node: '>=22.12.0 <23' }, bundleDependencies: ['express', 'zod'] });
    expect(manifest.engines).toEqual(rootPkg.engines);
    expect((manifest as Record<string, unknown>).bundleDependencies).toBeUndefined();
  });

  it('names the tarball after its Node major, platform and architecture', () => {
    expect(bundledTarballName({ name: 'ai-agent-session-center', version: '2.10.64' }, '22.14.0', 'linux', 'x64'))
      .toBe('ai-agent-session-center-2.10.64-node22-linux-x64.tgz');
  });
});

describe('the staged package', () => {
  let work = '';
  let fakeRoot = '';
  let out = '';
  let files: string[] = [];
  let manifest: Record<string, unknown> & { dependencies: Record<string, string> } = { dependencies: {} };
  let needed = new Set<string>();

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'aasc-pack-'));
    fakeRoot = join(work, 'root');
    out = join(work, 'out');
    mkdirSync(join(fakeRoot, 'dist', 'client'), { recursive: true });
    copyFileSync(join(ROOT, 'package.json'), join(fakeRoot, 'package.json'));
    for (const d of ['bin', 'hooks', 'scripts']) symlinkSync(join(ROOT, d), join(fakeRoot, d));
    writeFileSync(join(fakeRoot, 'dist', 'client', 'index.html'), '<!doctype html>');
    // Real bundles from the real sources, written outside the checkout.
    await build({ ...serverBuildOptions, absWorkingDir: ROOT, outfile: join(fakeRoot, 'dist', 'server-bundle.cjs'), logLevel: 'silent' });
    await build({ ...adminBuildOptions, absWorkingDir: ROOT, outfile: join(fakeRoot, 'dist', 'cli', 'admin.cjs'), logLevel: 'silent' });
    needed = new Set([
      ...externalPackages(readFileSync(join(fakeRoot, 'dist', 'server-bundle.cjs'), 'utf8')),
      ...externalPackages(readFileSync(join(fakeRoot, 'dist', 'cli', 'admin.cjs'), 'utf8')),
    ]);
    manifest = stageServerPackage({ root: fakeRoot, out }).manifest as typeof manifest;
    files = packedFiles(out);
  }, 120_000);

  afterAll(() => { rmSync(work, { recursive: true, force: true }); });

  it('declares every external require() in the bundles, and nothing frontend', () => {
    expect(needed.size).toBeGreaterThan(5);
    for (const name of needed) expect(manifest.dependencies[name], name).toBe(rootPkg.dependencies[name]);
    expect(Object.keys(manifest.dependencies).sort()).toEqual([...needed].sort());
    for (const name of Object.keys(manifest.dependencies)) {
      expect(name).not.toMatch(/^(react|react-dom|three|electron|tsx)$|^@react-three\//);
    }
  });

  it('writes the generated package.json into the staged folder, unchanged by the default mode', () => {
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'))).toEqual(manifest);
    expect(manifest.engines).toEqual(rootPkg.engines);
    expect(manifest.bundleDependencies).toBeUndefined();
  });

  it('packs the bundles, the UI, the hooks and set-password, and no source', () => {
    for (const f of [
      'package.json', 'bin/cli.js', 'bin/cliPlan.js', 'dist/server-bundle.cjs', 'dist/cli/admin.cjs', 'dist/client/index.html',
      'hooks/dataDir.js', 'hooks/setup-wizard.js', 'hooks/install-hooks.js', 'hooks/dashboard-hook.sh',
      'hooks/dashboard-statusline.sh', 'scripts/set-password.mjs',
    ]) {
      expect(files, f).toContain(f);
    }
    for (const f of files) {
      expect(f).not.toMatch(/^(server|src|electron|cli|test)\//);
      expect(f).not.toMatch(/\.tsx?$/);
      expect(f).not.toMatch(/\.test\./);
    }
    // Only the one script the package runs; the rest of scripts/ is build tooling.
    expect(files.filter((f) => f.startsWith('scripts/'))).toEqual(['scripts/set-password.mjs']);
  });
});
