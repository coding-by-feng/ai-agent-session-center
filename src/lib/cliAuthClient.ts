/**
 * The host's agent-CLI sign-in, for the "Log in" strip (desktop LIVE, remote windows) and banner
 * (phone Sessions). Server: GET /api/cli-auth, POST /api/cli-auth/:cli/login (server/cliAuthRouter.ts).
 */
import { authFetch } from '@/hooks/useAuth';
import { CLI_AUTH_LABELS, type CliAuthInfo, type CliAuthReport } from '@/types/cliAuth';
import type { AgentCli } from '@/types/cliVersions';

/** How often a dashboard asks (the server answers from a 5-minute cache). */
export const CLI_AUTH_POLL_MS = 5 * 60_000;
/** After "Log in": how often to look again, and for how long. */
export const CLI_AUTH_FAST_POLL_MS = 15_000;
export const CLI_AUTH_FAST_WINDOW_MS = 10 * 60_000;

/** null when the server can't say (an older server without the route, a network error). */
export async function fetchCliAuth(refresh = false, fetcher: typeof fetch = authFetch): Promise<CliAuthReport | null> {
  try {
    const res = await fetcher(`/api/cli-auth${refresh ? '?refresh=1' : ''}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: CliAuthReport };
    return body.data ?? null;
  } catch {
    return null;
  }
}

export type StartLoginResult = { ok: true; terminalId: string } | { ok: false; error: string };

export async function startCliLogin(cli: AgentCli, fetcher: typeof fetch = authFetch): Promise<StartLoginResult> {
  try {
    const res = await fetcher(`/api/cli-auth/${cli}/login`, { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { data?: { terminalId?: string }; error?: string };
    if (res.ok && body.data?.terminalId) return { ok: true, terminalId: body.data.terminalId };
    return { ok: false, error: body.error || `Could not open the login terminal (${res.status})` };
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
}

/** "Claude Code isn't logged in on mbp" / "Claude Code and Codex aren't logged in on mbp". */
export function loginNeededTitle(needed: readonly CliAuthInfo[], host: string): string {
  const names = needed.map((c) => CLI_AUTH_LABELS[c.cli]);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} aren't` : `${names[0]} isn't`;
  return `${who} logged in on ${host}`;
}
