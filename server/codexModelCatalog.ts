import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';

export const CODEX_MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
export const CODEX_MODEL_QUERY_TIMEOUT_MS = 8_000;

export interface CodexModelOption {
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface CodexModelCatalog {
  models: CodexModelOption[];
  refreshedAt: string;
  source: 'codex-app-server' | 'memory-cache' | 'stale-memory-cache';
  stale: boolean;
}

interface CachedCatalog {
  models: CodexModelOption[];
  refreshedAtMs: number;
}

const SAFE_MODEL_ID_RE = /^[a-zA-Z0-9._-]+$/;
const INITIALIZE_REQUEST_ID = 1;
const MODEL_LIST_REQUEST_ID = 2;

let cachedCatalog: CachedCatalog | null = null;
let refreshInFlight: Promise<CodexModelCatalog> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize the stable app-server `model/list` result into renderer-safe data. */
export function normalizeCodexModelList(result: unknown): CodexModelOption[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return [];

  const seen = new Set<string>();
  const models: CodexModelOption[] = [];
  for (const raw of result.data) {
    if (!isRecord(raw) || raw.hidden === true) continue;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || !SAFE_MODEL_ID_RE.test(id) || seen.has(id)) continue;

    seen.add(id);
    models.push({
      id,
      displayName:
        typeof raw.displayName === 'string' && raw.displayName.trim()
          ? raw.displayName.trim()
          : id,
      description: typeof raw.description === 'string' ? raw.description.trim() : '',
      isDefault: raw.isDefault === true,
    });
  }
  return models;
}

function spawnCodexAppServer(): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32') {
    // npm-installed CLIs are .cmd shims on Windows, so let cmd.exe resolve it.
    return spawn('codex app-server', [], { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  // Packaged macOS apps often inherit a minimal PATH. A login shell resolves the
  // same user-installed `codex` binary that an interactive terminal would use.
  const shell = process.env.SHELL || '/bin/sh';
  return spawn(shell, ['-lc', 'exec codex app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function queryCodexAppServer(): Promise<CodexModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawnCodexAppServer();
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    let stderr = '';

    const finish = (error: Error | null, models?: CodexModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      lines.close();
      child.kill();
      if (error) reject(error);
      else resolve(models ?? []);
    };

    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Codex model catalog timed out after ${CODEX_MODEL_QUERY_TIMEOUT_MS}ms`));
    }, CODEX_MODEL_QUERY_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer | string) => {
      if (stderr.length < 4_096) stderr += chunk.toString();
    });
    child.stdin.on('error', (error) => finish(error));
    child.on('error', (error) => finish(error));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const detail = stderr.trim().replace(/\s+/g, ' ').slice(0, 500);
      finish(new Error(
        `Codex app-server exited before model/list completed (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`,
      ));
    });

    lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isRecord(parsed)) return;
        message = parsed;
      } catch {
        // A user's login shell may print a banner before `exec codex`; ignore it.
        return;
      }

      if (message.id === INITIALIZE_REQUEST_ID) {
        if (isRecord(message.error)) {
          finish(new Error(`Codex app-server initialize failed: ${String(message.error.message ?? 'unknown error')}`));
          return;
        }
        send({ method: 'initialized', params: {} });
        send({
          method: 'model/list',
          id: MODEL_LIST_REQUEST_ID,
          params: { includeHidden: false, limit: 100 },
        });
        return;
      }

      if (message.id === MODEL_LIST_REQUEST_ID) {
        if (isRecord(message.error)) {
          finish(new Error(`Codex model/list failed: ${String(message.error.message ?? 'unknown error')}`));
          return;
        }
        const models = normalizeCodexModelList(message.result);
        if (models.length === 0) {
          finish(new Error('Codex model/list returned no selectable models'));
          return;
        }
        finish(null, models);
      }
    });

    send({
      method: 'initialize',
      id: INITIALIZE_REQUEST_ID,
      params: {
        clientInfo: {
          name: 'ai_agent_session_center',
          title: 'AI Agent Session Center',
          version: '1.0.0',
        },
      },
    });
  });
}

function catalogFromCache(
  cached: CachedCatalog,
  source: CodexModelCatalog['source'],
  stale: boolean,
): CodexModelCatalog {
  return {
    models: cached.models,
    refreshedAt: new Date(cached.refreshedAtMs).toISOString(),
    source,
    stale,
  };
}

/** Return the current account-visible Codex catalog, coalescing concurrent refreshes. */
export async function getCodexModelCatalog(): Promise<CodexModelCatalog> {
  const now = Date.now();
  if (cachedCatalog && now - cachedCatalog.refreshedAtMs < CODEX_MODEL_CACHE_TTL_MS) {
    return catalogFromCache(cachedCatalog, 'memory-cache', false);
  }
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const models = await queryCodexAppServer();
      cachedCatalog = { models, refreshedAtMs: Date.now() };
      return catalogFromCache(cachedCatalog, 'codex-app-server', false);
    } catch (error) {
      if (cachedCatalog) return catalogFromCache(cachedCatalog, 'stale-memory-cache', true);
      throw error;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}
