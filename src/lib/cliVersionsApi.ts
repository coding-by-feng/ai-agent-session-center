/**
 * The client side of the Mac's agent CLI versions and their one-click update (Oct 25 2026). The
 * update's progress arrives as `cli_update` on the WebSocket; these calls read and start it.
 */
import { readJson } from '@/lib/requestJson';
import { AGENT_CLIS, type AgentCli, type CliUpdateState, type CliVersionInfo } from '@/types/cliVersions';

const READ_FAILED = 'Could not read the CLI versions';
const UPDATE_FAILED = 'Could not start the update';
const STATES: readonly CliUpdateState[] = ['idle', 'updating', 'updated', 'current', 'failed'];

const versionOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const optional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v);
const isLines = (v: unknown): boolean => Array.isArray(v) && v.every((l) => typeof l === 'string');

/** Untrusted shape: a well-formed version info, or false. */
export function isCliVersionInfo(value: unknown): value is CliVersionInfo {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const u = v.update as Record<string, unknown> | undefined;
  return (
    AGENT_CLIS.includes(v.cli as AgentCli)
    && versionOrNull(v.installed)
    && versionOrNull(v.latest)
    && typeof v.updateAvailable === 'boolean'
    && typeof v.checkedAt === 'number'
    && !!u && typeof u === 'object' && STATES.includes(u.state as CliUpdateState)
    && optional(u.startedAt, (x) => typeof x === 'number')
    && optional(u.log, isLines)
  );
}

export async function fetchCliVersions(refresh = false, signal?: AbortSignal): Promise<CliVersionInfo[]> {
  const res = await fetch(`/api/cli-versions${refresh ? '?refresh=1' : ''}`, { signal });
  const body = await readJson<{ success?: boolean; data?: unknown; error?: string }>(res, READ_FAILED);
  if (!body.success || !Array.isArray(body.data)) throw new Error(body.error || READ_FAILED);
  return body.data.filter(isCliVersionInfo);
}

export async function startCliUpdate(cli: AgentCli): Promise<void> {
  const res = await fetch(`/api/cli-versions/${cli}/update`, { method: 'POST' });
  const body = await readJson<{ success?: boolean; error?: string }>(res, UPDATE_FAILED);
  if (!body.success) throw new Error(body.error || UPDATE_FAILED);
}
