import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// cjsRename.mjs rewrites require() specifiers only, so a bare preload filename in main.ts silently loads nothing.
const root = process.cwd();
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('Electron preload path vs. the CJS rename step', () => {
  const mainSrc = read('electron/main.ts');
  const renameSrc = read('scripts/cjsRename.mjs');

  // Read the emitted extension from the script rather than assuming it, so a
  // change to the build step fails here before it ships a silent preload.
  const emitted = renameSrc.match(
    /renameSync\(file, file\.slice\(0, -'\.js'\.length\) \+ '(\.[a-z]+)'\)/,
  )?.[1];

  it('the rename step still emits a known extension', () => {
    expect(emitted).toBe('.cjs');
  });

  it('PRELOAD_PATH names the extension the rename step emits', () => {
    const m = mainSrc.match(/const PRELOAD_PATH = path\.join\(__dirname, '([^']+)'\)/);
    expect(m, 'main.ts must define PRELOAD_PATH via path.join(__dirname, …)').not.toBeNull();
    expect(m![1]).toBe(`preload${emitted}`);
  });

  it('every BrowserWindow loads its preload through PRELOAD_PATH, never a literal', () => {
    const preloadOptions = mainSrc.split('\n').filter((line) => /^\s*preload:/.test(line));
    expect(preloadOptions.length).toBeGreaterThanOrEqual(5);
    for (const line of preloadOptions) {
      expect(line.trim()).toBe('preload: PRELOAD_PATH,');
    }
  });

  it("no 'preload.js' literal survives anywhere under electron/", () => {
    for (const file of walkTs(join(root, 'electron'))) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/['"]preload\.js['"]/);
    }
  });

  it('a preload that fails to load is logged, not silent', () => {
    const crash = read('electron/crashLogger.ts');
    expect(crash).toMatch(/app\.on\('web-contents-created'/);
    expect(crash).toMatch(/\.on\('preload-error'/);
  });
});
