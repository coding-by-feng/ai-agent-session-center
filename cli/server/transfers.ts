/**
 * `aasc-server transfers [--json]`, `transfers allow <id>`, `transfers decline <id>`,
 * `transfers forget <computer>` (Nov 27 2026): Project Transfer on a server with no screen.
 *
 * Another computer that sends a project here waits (15 minutes at most) for this computer's owner to
 * press Allow once for it. On a desktop that's a prompt in the dashboard; a headless server's owner
 * answers here instead, over the owner token (GET/POST /api/project-transfer/requests, this machine
 * only). `forget` takes a computer's Allow back. <id> and <computer> are any unique prefix.
 */
import type { IncomingTransferRequest } from '../../src/types/projectTransfer.js';
import { ago } from './devices.js';
import { EXIT, errorOf, safeText, type AdminClient } from './http.js';

interface AllowedRow { computerId: string; label: string; allowedAt: number }

export interface TransfersDeps {
  client: AdminClient;
  /** What follows `transfers`: [] to list, ['allow', id], ['decline', id] or ['forget', computer]. */
  args: string[];
  json: boolean;
  out: (line: string) => void;
  now: () => number;
}

const USAGE = 'Usage: aasc-server transfers [allow <id> | decline <id> | forget <computer>] [--json]';
const BASE = '/api/project-transfer';

function size(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

async function read<T>(client: AdminClient, path: string, what: string): Promise<T[] | string> {
  const res = await client.request('GET', `${BASE}${path}`);
  if (res.status === 404) return 'This server has no Project Transfer (it is older than Nov 27 2026).';
  if (res.status !== 200) return errorOf(res, `Could not read ${what}`);
  const data = (res.body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as T[]) : `Could not read ${what}`;
}

function pick<T>(rows: T[], prefix: string, idOf: (r: T) => string, kind: string): T | string {
  if (!prefix) return `Name a ${kind} by its ID (see \`aasc-server transfers\`).`;
  const matches = rows.filter((r) => idOf(r).startsWith(prefix));
  if (matches.length === 0) return `No ${kind} has an ID starting ${safeText(prefix)}.`;
  if (matches.length > 1) return `${matches.length} ${kind}s have an ID starting ${safeText(prefix)}: give more of it.`;
  return matches[0];
}

async function list(deps: TransfersDeps): Promise<number> {
  const waiting = await read<IncomingTransferRequest>(deps.client, '/requests', 'the waiting transfers');
  if (typeof waiting === 'string') return fail(deps, waiting);
  const allowed = await read<AllowedRow>(deps.client, '/allowed', 'the allowed computers');
  if (typeof allowed === 'string') return fail(deps, allowed);
  if (deps.json) {
    deps.out(JSON.stringify({ waiting, allowed }, null, 2));
    return EXIT.OK;
  }
  if (waiting.length === 0) deps.out('No transfer is waiting for Allow.');
  else {
    deps.out('Waiting for Allow:');
    for (const r of waiting) {
      deps.out(`  ${r.id.slice(0, 8)}  ${safeText(r.computerLabel)} → ${safeText(r.destination)}  ${r.files} files · ${size(r.bytes)}  ${ago(r.requestedAt, deps.now())}`);
    }
    deps.out('  Answer with `aasc-server transfers allow <id>` (remembers that computer) or `decline <id>`.');
  }
  if (allowed.length === 0) deps.out('No computer is allowed to send projects here yet.');
  else {
    deps.out('Allowed to send projects here:');
    for (const a of allowed) deps.out(`  ${a.computerId.slice(0, 8)}  ${safeText(a.label)}  since ${ago(a.allowedAt, deps.now())}`);
  }
  return EXIT.OK;
}

function fail(deps: TransfersDeps, message: string): number {
  deps.out(message);
  return EXIT.FAILED;
}

export async function runTransfers(deps: TransfersDeps): Promise<number> {
  const [action, target = '', ...extra] = deps.args;
  if (action === undefined || action === 'list') return extra.length > 0 || target ? usage(deps) : list(deps);
  if (extra.length > 0 || !['allow', 'decline', 'forget'].includes(action)) return usage(deps);

  if (action === 'forget') {
    const allowed = await read<AllowedRow>(deps.client, '/allowed', 'the allowed computers');
    if (typeof allowed === 'string') return fail(deps, allowed);
    const one = pick(allowed, target, (a) => a.computerId, 'allowed computer');
    if (typeof one === 'string') return fail(deps, one);
    const res = await deps.client.request('DELETE', `${BASE}/allowed/${encodeURIComponent(one.computerId)}`);
    if (res.status !== 200) return fail(deps, errorOf(res, 'Could not forget that computer'));
    deps.out(`${safeText(one.label)} must ask for Allow again before it can send a project here.`);
    return EXIT.OK;
  }

  const waiting = await read<IncomingTransferRequest>(deps.client, '/requests', 'the waiting transfers');
  if (typeof waiting === 'string') return fail(deps, waiting);
  const one = pick(waiting, target, (r) => r.id, 'waiting transfer');
  if (typeof one === 'string') return fail(deps, one);
  const res = await deps.client.request('POST', `${BASE}/requests/${encodeURIComponent(one.id)}/${action}`);
  if (res.status !== 200) return fail(deps, errorOf(res, `Could not ${action} that transfer`));
  deps.out(action === 'allow'
    ? `Allowed. ${safeText(one.computerLabel)} is sending ${safeText(one.projectName)} to ${safeText(one.destination)}, and may send projects here from now on.`
    : `Declined. ${safeText(one.computerLabel)} can't send that transfer again.`);
  return EXIT.OK;
}

function usage(deps: TransfersDeps): number {
  deps.out(USAGE);
  return EXIT.USAGE;
}
