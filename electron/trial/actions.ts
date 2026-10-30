import type { TrialClient, TrialSnapshot } from '../../bin/trial/client.cjs';

export type TrialAction = 'refresh' | 'activate' | 'ask' | 'retry' | 'logout';
export type TrialActionResult =
  | { ok: true; data: TrialSnapshot }
  | { ok: false; error: string; data?: TrialSnapshot };
const CODES = new Set([
  'runtime_unavailable',
  'native_runtime_required',
  'invalid_request',
  'invalid_prompt',
  'code_unavailable',
  'network_error',
  'rate_limited',
  'runtime_busy',
  'daily_budget_exhausted',
  'trial_scope_restricted',
  'turn_pending',
  'unauthorized',
  'trial_expired',
  'trial_revoked',
  'quota_exhausted',
  'idempotency_conflict',
  'client_busy',
  'storage_error',
  'credential_changed',
  'credential_missing',
  'invalid_response',
  'credential_store_unavailable',
  'credential_store_invalid',
  'request_pending',
  'busy',
]);

export async function invokeTrialAction(
  client: TrialClient,
  origin: string,
  sender: { url: string; mainFrame: boolean },
  action: unknown,
  input?: unknown,
): Promise<TrialActionResult> {
  try {
    if (!sender.mainFrame || new URL(sender.url).origin !== origin)
      return { ok: false, error: 'untrusted_window' };
  } catch {
    return { ok: false, error: 'untrusted_window' };
  }
  if (!['refresh', 'activate', 'ask', 'retry', 'logout'].includes(String(action)))
    return { ok: false, error: 'invalid_request' };
  if (
    action === 'activate' &&
    (typeof input !== 'string' || input.trim().length < 10 || input.length > 80)
  )
    return { ok: false, error: 'invalid_request' };
  if (action === 'ask' && (typeof input !== 'string' || !input.trim() || input.length > 600))
    return { ok: false, error: 'invalid_prompt' };
  try {
    let data: TrialSnapshot;
    if (action === 'refresh') {
      await client.status();
      data = await client.state();
    } else if (action === 'activate') data = await client.activate((input as string).trim());
    else if (action === 'ask') data = await client.ask((input as string).trim());
    else if (action === 'retry') data = await client.retry();
    else data = await client.logout();
    // Explicit envelope projection: local credential state is never an IPC result.
    return {
      ok: true,
      data: { status: data.status, session: data.session, pending: data.pending, busy: data.busy },
    };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    const data = client.getSnapshot();
    return {
      ok: false,
      error: typeof code === 'string' && CODES.has(code) ? code : 'runtime_unavailable',
      data: { status: data.status, session: data.session, pending: data.pending, busy: data.busy },
    };
  }
}
