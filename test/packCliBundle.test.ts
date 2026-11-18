import { describe, it, expect, beforeAll } from 'vitest';
import { build, type Metafile } from 'esbuild';
import { relative, resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
// @ts-expect-error — a plain .mjs build script, no type declarations
import { cliBuildOptions, nonBuiltinRequires } from '../scripts/pack-cli.mjs';

const ROOT = resolve(__dirname, '..');
/**
 * The only electron/ files the terminal client may bundle: pure Node (crypto + each other).
 * They stay in electron/remote/ because tsconfig.electron.json's rootDir is `electron`.
 */
const ALLOWED_ELECTRON_INPUTS = ['electron/remote/remoteClient.ts', 'electron/remote/pairingLinkRules.ts'];

describe('the aasc bundle', () => {
  let text = '';
  let inputs: string[] = [];

  beforeAll(async () => {
    // In memory: nothing is written to dist/.
    const result = await build(cliBuildOptions({ write: false, metafile: true, logLevel: 'silent' }));
    text = result.outputFiles[0].text;
    inputs = Object.keys((result.metafile as Metafile).inputs).map((p) => relative(ROOT, resolve(ROOT, p)));
  }, 30_000);

  it('never requires electron', () => {
    expect(text).not.toMatch(/\brequire\(\s*["']electron["']\s*\)/);
    expect(inputs.some((p) => p.includes('node_modules/electron/'))).toBe(false);
  });

  it('requires nothing outside Node’s built-ins', () => {
    expect(nonBuiltinRequires(text).outside).toEqual([]);
  });

  it('takes from electron/ only the two pure remote modules', () => {
    const fromElectron = inputs.filter((p) => p.startsWith('electron/')).sort();
    expect(fromElectron).toEqual([...ALLOWED_ELECTRON_INPUTS].sort());
  });

  it('pulls in no React, Three.js or store code from src/', () => {
    const fromSrc = inputs.filter((p) => p.startsWith('src/'));
    expect(fromSrc.every((p) => p.startsWith('src/lib/') && !p.includes('/vendor/three'))).toBe(true);
    expect(inputs.some((p) => /node_modules\/(react|three|zustand|@react-three)\//.test(p))).toBe(false);
  });
});

// Nov 19 2026: the package had no README, so its npm page would have been blank, and a published version can't
// be changed. Every command the README names must be one the client's usage lists.
describe('the aasc package README', () => {
  const source = resolve(ROOT, 'scripts', 'cli-package-readme.md');

  it('exists, is staged by the pack script, and names only real commands', () => {
    expect(existsSync(source)).toBe(true);
    const readme = readFileSync(source, 'utf8');
    const usage = readFileSync(resolve(ROOT, 'cli', 'client', 'index.ts'), 'utf8');
    const named = [...readme.matchAll(/^aasc ([a-z]+)/gm)].map((m) => m[1]);
    expect(named).toContain('add');
    for (const command of new Set(named)) expect(usage, command).toContain(`aasc ${command} `);
    expect(readFileSync(resolve(ROOT, 'scripts', 'pack-cli.mjs'), 'utf8')).toContain("'cli-package-readme.md'");
    expect(readme).not.toMatch(/\/Users\//);
  });
});

