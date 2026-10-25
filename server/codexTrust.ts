// codexTrust.ts — which folders the owner's Codex already trusts (Ruling P4-46), read-only.
//
// Codex 0.163 asks "Trust this folder?" in a folder it has no trust record for, and AASC never answers that prompt
// (sshManager's auto-confirm knows only Claude's). Codex keeps its answers in `~/.codex/config.toml`, one
// `[projects."<path>"]` table per folder with `trust_level = "trusted"`. A Codex card launched in such a folder shows
// no prompt and waits at its input, so the connecting timeout may count it as heard (sessionStore `leaveConnecting`).
//
// Never written or created here. Read through an injected reader, parsed again only when its mtime changes; the file is
// `$CODEX_HOME/config.toml` (else `~/.codex/config.toml`), as Codex reads it. A missing, unreadable or unparsable file
// trusts nothing. Codex matches its physical cwd against the keys as written, so the card folder's native real path
// (realpathSync.native keeps APFS case, like getcwd) is compared with each key EXACTLY (Ruling P4-51): a key naming a
// link, one with a trailing slash, and a sub-folder of a trusted folder are not trusted here. A wrong "trusted" would
// type into the trust prompt; a wrong "untrusted" only fails a task visibly.

import { readFileSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { parse as parseToml } from 'smol-toml';

export interface CodexTrustDeps {
  /** The config file's mtime in ms, or null when it is missing or unreadable. */
  mtime(): number | null;
  /** The config file's text; throws when it cannot be read. */
  read(): string;
  /** The card folder's real path, or null when it does not resolve. */
  realpath(path: string): string | null;
}

/** Where Codex keeps its config: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
export function codexConfigPath(): string {
  const home = process.env.CODEX_HOME;
  return join(home ? home : join(homedir(), '.codex'), 'config.toml');
}

const defaultDeps: CodexTrustDeps = {
  mtime: () => {
    try {
      return statSync(codexConfigPath()).mtimeMs;
    } catch {
      return null;
    }
  },
  read: () => readFileSync(codexConfigPath(), 'utf8'),
  realpath: (path) => {
    try {
      return realpathSync.native(path);
    } catch {
      return null;
    }
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The folders a config's `[projects."<path>"]` tables mark `trust_level = "trusted"`; none for text that does not parse. */
export function trustedFolders(text: string): string[] {
  let doc: unknown;
  try {
    doc = parseToml(text);
  } catch {
    return [];
  }
  const projects = isRecord(doc) ? doc.projects : undefined;
  if (!isRecord(projects)) return [];
  return Object.entries(projects)
    .filter(([, table]) => isRecord(table) && table.trust_level === 'trusted')
    .map(([path]) => path);
}

export interface CodexTrust {
  /** Does the owner's Codex trust this folder (its real path listed `trusted`)? */
  trusts(folder: string): boolean;
}

export function createCodexTrust(over: Partial<CodexTrustDeps> = {}): CodexTrust {
  const deps: CodexTrustDeps = { ...defaultDeps, ...over };
  let cached: { path: string; mtime: number; folders: ReadonlySet<string> } | null = null;

  function folders(): ReadonlySet<string> {
    const mtime = deps.mtime();
    if (mtime === null) return new Set();
    // Keyed by the file too: CODEX_HOME may point elsewhere since the last read.
    const path = codexConfigPath();
    if (cached?.mtime === mtime && cached.path === path) return cached.folders;
    let text: string;
    try {
      text = deps.read();
    } catch {
      return new Set();
    }
    // The keys exactly as written: never resolved, never trimmed.
    cached = { path, mtime, folders: new Set(trustedFolders(text)) };
    return cached.folders;
  }

  return {
    trusts(folder) {
      const real = deps.realpath(folder);
      return real !== null && folders().has(real);
    },
  };
}
