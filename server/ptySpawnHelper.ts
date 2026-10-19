/**
 * @module ptySpawnHelper
 * Make node-pty's `spawn-helper` executable before the first terminal starts.
 *
 * On macOS and Linux node-pty starts every PTY through a tiny `spawn-helper` binary that it
 * ships in `prebuilds/<platform>-<arch>/` (or builds into `build/Release/`). npm unpacks it
 * as 0644; node-pty's own postinstall, and ours (bin/postinstall.js), add the execute bit.
 * npm 11 runs no install scripts until the user approves them, so an
 * `npx ai-agent-session-center` install kept the helper at 0644 and every terminal failed
 * with "posix_spawnp failed". The server repairs the bit itself at startup, so it no longer
 * depends on install scripts having run.
 *
 * The packaged Electron app is not touched: electron-builder unpacks the helper executable,
 * and the app bundle is not ours to rewrite at runtime.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export interface SpawnHelperResult {
  /** Helpers that were not executable and now are. */
  fixed: string[];
  /** Helpers that could not be changed (for example a root-owned global install). */
  failed: Array<{ file: string; error: string }>;
}

interface EnsureOptions {
  /** node-pty's package folder; defaults to the installed one, null when it cannot be found. */
  ptyRoot?: string | null;
  platform?: NodeJS.Platform;
  chmod?: (file: string, mode: number) => void;
}

/** Where node-pty keeps the helper: a local build, and every prebuild folder it ships. */
export function spawnHelperCandidates(ptyRoot: string): string[] {
  const candidates = [
    path.join(ptyRoot, 'build', 'Release', 'spawn-helper'),
    path.join(ptyRoot, 'build', 'Debug', 'spawn-helper'),
  ];
  const prebuilds = path.join(ptyRoot, 'prebuilds');
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) candidates.push(path.join(prebuilds, dir, 'spawn-helper'));
  }
  return candidates;
}

function installedPtyRoot(): string | null {
  try {
    return path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
  } catch {
    return null;
  }
}

/** Add the execute bit to every node-pty spawn-helper that lacks it. Never throws. */
export function ensureSpawnHelperExecutable(options: EnsureOptions = {}): SpawnHelperResult {
  const result: SpawnHelperResult = { fixed: [], failed: [] };
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return result;
  const ptyRoot = options.ptyRoot === undefined ? installedPtyRoot() : options.ptyRoot;
  if (!ptyRoot) return result;
  const chmod = options.chmod ?? chmodSync;
  for (const file of spawnHelperCandidates(ptyRoot)) {
    if (!existsSync(file)) continue;
    const mode = statSync(file).mode;
    if ((mode & 0o111) === 0o111) continue;
    try {
      chmod(file, (mode & 0o777) | 0o755);
      result.fixed.push(file);
    } catch (err) {
      result.failed.push({ file, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}
