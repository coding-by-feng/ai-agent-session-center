/**
 * Claude model catalog — the list Claude Code's own `/model` picker offers, read
 * from the installed `claude` CLI so AASC's model lists follow new releases (Fable
 * 5.2 appeared in `/model` while AASC still said 5.1). The Claude sibling of
 * `codexModelCatalog.ts`.
 *
 * How: `claude -p --input-format stream-json` answers an SDK `initialize` control
 * request with `models` — each `/model` row with the ID an alias means today
 * (`fable` → `claude-fable-5-2`). No prompt is sent, so no model call is made; the
 * probe runs with every settings source off and hooks disabled (it must never become
 * a dashboard card), no session file, the launching session's env markers stripped,
 * and a temp-dir cwd.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { tmpdir } from 'os';
import { createInterface } from 'readline';
import { stripInheritedClaudeSessionEnv } from './config.js';

export const CLAUDE_MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
export const CLAUDE_MODEL_QUERY_TIMEOUT_MS = 15_000;

export interface ClaudeModelOption {
  /** What `--model` / `/model` takes: a tier alias (`opus`) or a full ID. */
  id: string;
  /** The model the ID means today (`opus` → `claude-opus-5-5`); equals `id` for a full ID. */
  resolvedModel: string;
  displayName: string;
  description: string;
}

export interface ClaudeModelCatalog {
  models: ClaudeModelOption[];
  refreshedAt: string;
  source: 'claude-cli' | 'memory-cache' | 'stale-memory-cache';
  stale: boolean;
}

interface CachedCatalog {
  models: ClaudeModelOption[];
  refreshedAtMs: number;
}

/** Unquoted `--model` values only: `claude-fable-5-1[1m]` would glob in zsh. */
const SAFE_MODEL_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
/** The picker's "Default (recommended)" row: a setting, not a model name. */
const DEFAULT_ROW = 'default';
const INITIALIZE_REQUEST_ID = 'aasc-models-1';

/** Flags that keep the probe from loading settings, hooks, MCP or writing a session. */
export const CLAUDE_PROBE_ARGS = [
  '-p',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose',
  '--setting-sources', '',
  '--settings', '{"disableAllHooks":true}',
  '--no-session-persistence',
  '--strict-mcp-config',
  '--disable-slash-commands',
] as const;

let cachedCatalog: CachedCatalog | null = null;
let refreshInFlight: Promise<ClaudeModelCatalog> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Normalize the `initialize` response's `models` into renderer-safe rows, in CLI order. */
export function normalizeClaudeModelList(response: unknown): ClaudeModelOption[] {
  if (!isRecord(response) || !Array.isArray(response.models)) return [];

  const seen = new Set<string>();
  const models: ClaudeModelOption[] = [];
  for (const raw of response.models) {
    if (!isRecord(raw)) continue;
    const id = text(raw.value);
    if (!id || id === DEFAULT_ROW || !SAFE_MODEL_ID_RE.test(id) || seen.has(id)) continue;
    const resolved = text(raw.resolvedModel);
    seen.add(id);
    models.push({
      id,
      resolvedModel: resolved && SAFE_MODEL_ID_RE.test(resolved) ? resolved : id,
      displayName: text(raw.displayName) || id,
      description: text(raw.description),
    });
  }
  return models;
}

const shellQuote = (arg: string): string => `'${arg.replace(/'/g, `'\\''`)}'`;

function spawnClaudeProbe(): ChildProcessWithoutNullStreams {
  const env = stripInheritedClaudeSessionEnv(process.env);
  const cwd = tmpdir();
  if (process.platform === 'win32') {
    // npm-installed CLIs are .cmd shims on Windows, so let cmd.exe resolve it. cmd
    // can't carry the JSON `--settings` safely; `--setting-sources ""` already keeps
    // every settings file — and so every hook — out.
    const args = CLAUDE_PROBE_ARGS.filter((a, i, all) => a !== '--settings' && all[i - 1] !== '--settings')
      .map((a) => (a === '' ? '""' : a));
    return spawn(`claude ${args.join(' ')}`, [], { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  // Packaged macOS apps inherit a minimal PATH; a login shell finds the user's `claude`.
  const shell = process.env.SHELL || '/bin/sh';
  const line = `exec claude ${CLAUDE_PROBE_ARGS.map(shellQuote).join(' ')}`;
  return spawn(shell, ['-lc', line], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Ask a freshly spawned CLI for its model list. `spawnProbe` is injectable for tests. */
export function queryClaudeCli(
  spawnProbe: () => ChildProcessWithoutNullStreams = spawnClaudeProbe,
  timeoutMs: number = CLAUDE_MODEL_QUERY_TIMEOUT_MS,
): Promise<ClaudeModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawnProbe();
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = '';

    const finish = (error: Error | null, models?: ClaudeModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.stdin.end();
      child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Claude model catalog timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 4_096) stderr += chunk.toString();
    });
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
      finish(new Error(
        `claude exited before initialize answered (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
      ));
    });

    lines.on('line', (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return; // a login-shell banner before `exec claude`
      }
      if (!isRecord(message) || message.type !== 'control_response' || !isRecord(message.response)) return;
      const response = message.response;
      if (response.request_id !== INITIALIZE_REQUEST_ID) return;
      if (response.subtype !== 'success') {
        finish(new Error(`claude initialize failed: ${text(response.error) || 'unknown error'}`));
        return;
      }
      const models = normalizeClaudeModelList(response.response);
      if (models.length === 0) {
        finish(new Error('claude initialize returned no selectable models'));
        return;
      }
      finish(null, models);
    });

    child.stdin.write(`${JSON.stringify({
      type: 'control_request',
      request_id: INITIALIZE_REQUEST_ID,
      request: { subtype: 'initialize' },
    })}\n`);
  });
}

function catalogFromCache(
  cached: CachedCatalog,
  source: ClaudeModelCatalog['source'],
  stale: boolean,
): ClaudeModelCatalog {
  return {
    models: cached.models,
    refreshedAt: new Date(cached.refreshedAtMs).toISOString(),
    source,
    stale,
  };
}

/** The installed CLI's `/model` list, cached 30 min, one refresh at a time. */
export async function getClaudeModelCatalog(
  query: () => Promise<ClaudeModelOption[]> = () => queryClaudeCli(),
): Promise<ClaudeModelCatalog> {
  const now = Date.now();
  if (cachedCatalog && now - cachedCatalog.refreshedAtMs < CLAUDE_MODEL_CACHE_TTL_MS) {
    return catalogFromCache(cachedCatalog, 'memory-cache', false);
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const models = await query();
      cachedCatalog = { models, refreshedAtMs: Date.now() };
      return catalogFromCache(cachedCatalog, 'claude-cli', false);
    } catch (error) {
      if (cachedCatalog) return catalogFromCache(cachedCatalog, 'stale-memory-cache', true);
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Test seam: forget the cached catalog. */
export function resetClaudeModelCatalogForTests(): void {
  cachedCatalog = null;
  refreshInFlight = null;
}
