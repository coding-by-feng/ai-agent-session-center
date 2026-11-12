/**
 * `aasc-server status [--json]` (terminal-editions plan §8.4): what the running server is doing, from
 * its folder lock and four owner-token API reads. Exit 2 when the server isn't running.
 */
import { homedir } from 'os';
import { EXIT, AdminError, readConfig, safeText, type AdminClient } from './http.js';
import { kindOf } from './devices.js';
import { AUTOMATION_NOTE, CLOUD_RECONNECT, cloudCredential, hookState } from './doctor.js';
import type { LockRecord } from '../../server/instanceLock.js';
import type { CliAuthInfo, CliAuthReport } from '../../src/types/cliAuth.js';

export interface StatusDeps {
  client: AdminClient | null;
  dataDir: string;
  port: number;
  version: string;
  home: string;
  env: NodeJS.ProcessEnv;
  lock: LockRecord | null;
  json: boolean;
  now: () => number;
  out: (line: string) => void;
}

interface SessionRow { status?: string; remoteVisible?: boolean }
interface DeviceRow { platform: string; status: string; online?: boolean }
interface PresenceDevice { clientId: string; label: string; cli?: boolean }

function uptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A home folder shown as ~, as people type it. */
function tilde(path: string, home: string): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

async function read<T>(client: AdminClient, path: string): Promise<T | null> {
  const res = await client.request('GET', path);
  return res.status === 200 ? (res.body as T) : null;
}

function sessionLine(sessions: SessionRow[]): string {
  const live = sessions.filter((s) => s.status !== 'ended');
  const count = (...statuses: string[]) => live.filter((s) => statuses.includes(s.status ?? '')).length;
  const parts = [
    [count('working', 'prompting'), 'working'],
    [count('approval'), 'needs approval'],
    [count('input'), 'needs an answer'],
    [count('waiting'), 'done'],
    [count('idle', 'connecting'), 'idle'],
    [live.filter((s) => s.remoteVisible === true).length, 'shared'],
  ] as const;
  return [String(live.length), ...parts.filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}`)].join(' · ');
}

/** "claude ✗ not logged in · codex ✓ ChatGPT". Server text, so passed through safeText. */
export function loginLine(clis: readonly CliAuthInfo[]): string {
  return clis.map((c) => {
    switch (c.state) {
      case 'logged-in': return `${c.cli} ✓${c.method ? ` ${safeText(c.method)}` : ''}`;
      case 'logged-out': return `${c.cli} ✗ not logged in`;
      case 'missing': return `${c.cli} – not installed`;
      default: return `${c.cli} ? couldn't tell`;
    }
  }).join(' · ');
}

function deviceLine(devices: DeviceRow[]): string {
  const paired = devices.filter((d) => d.status === 'active');
  const computers = paired.filter((d) => kindOf(d.platform) === 'computer').length;
  const phones = paired.length - computers;
  const waiting = devices.filter((d) => d.status === 'pending').length;
  const parts = [`${paired.length} paired`];
  if (paired.length > 0) parts.push([computers && plural(computers, 'computer'), phones && plural(phones, 'phone')].filter(Boolean).join(', '));
  parts.push(`${paired.filter((d) => d.online).length} online`);
  if (waiting > 0) parts.push(`${waiting} waiting for Allow`);
  return parts.join(' · ');
}

export async function runStatus(deps: StatusDeps): Promise<number> {
  const { out } = deps;
  const config = readConfig(deps.dataDir);
  const enabled = Array.isArray(config.enabledClis) && config.enabledClis.length > 0 ? config.enabledClis : ['claude'];
  const hooks = hookState(deps.home || homedir(), enabled);
  const cloud = cloudCredential(deps.dataDir);
  const bind = deps.lock?.bindAddress && !['0.0.0.0', '::'].includes(deps.lock.bindAddress) ? deps.lock.bindAddress : '*';
  const remotePort = deps.env.AASC_REMOTE_LISTENER_PORT || (config.remoteListenerPort ? String(config.remoteListenerPort) : '');

  let running = deps.client !== null;
  let auth: { passwordRequired?: boolean } | null = null;
  let sessions: SessionRow[] = [];
  let devices: DeviceRow[] = [];
  let addresses: { lan?: string | null; tailnet?: string | null; public?: string | null } = {};
  let presence: { devices?: PresenceDevice[]; workspaceWriter?: string | null } = {};
  let cliAuth: CliAuthReport | null = null;
  if (deps.client) {
    try {
      auth = await read<{ passwordRequired?: boolean }>(deps.client, '/api/auth/status');
      sessions = Object.values((await read<Record<string, SessionRow>>(deps.client, '/api/sessions')) ?? {});
      devices = (await read<{ data?: { devices?: DeviceRow[] } }>(deps.client, '/api/mobile/devices'))?.data?.devices ?? [];
      addresses = (await read<{ data?: typeof addresses }>(deps.client, '/api/mobile/pairing/addresses'))?.data ?? {};
      presence = (await read<{ data?: typeof presence }>(deps.client, '/api/presence'))?.data ?? {};
      // An older server has no such route: no row, rather than a wrong one.
      cliAuth = (await read<{ data?: CliAuthReport }>(deps.client, '/api/cli-auth'))?.data ?? null;
    } catch (err) {
      if (!(err instanceof AdminError) || err.exitCode !== EXIT.NOT_RUNNING) throw err;
      running = false;
    }
  }

  const writer = presence.devices?.find((d) => d.clientId === presence.workspaceWriter);
  const automation = writer ? `runs in ${safeText(writer.label)}` : 'paused: no dashboard is connected';

  if (deps.json) {
    out(JSON.stringify({
      version: deps.version,
      running,
      edition: deps.lock?.edition ?? null,
      pid: running ? deps.lock?.pid ?? null : null,
      startedAt: running ? deps.lock?.startedAt ?? null : null,
      dataDir: deps.dataDir,
      port: deps.port,
      bindAddress: bind === '*' ? null : bind,
      remoteListenerPort: remotePort ? Number(remotePort) : null,
      addresses,
      passwordSet: Boolean(config.passwordHash),
      sessions: { live: sessions.filter((s) => s.status !== 'ended').length, shared: sessions.filter((s) => s.status !== 'ended' && s.remoteVisible === true).length },
      devices,
      hooks,
      login: cliAuth ? Object.fromEntries(cliAuth.clis.map((c) => [c.cli, c.state])) : null,
      cloud: cloud === 'encrypted' ? 'reconnect' : cloud,
      automation: running ? (writer ? { writer: safeText(writer.label) } : { paused: true }) : null,
    }, null, 2));
    return running ? EXIT.OK : EXIT.NOT_RUNNING;
  }

  const head = running && deps.lock
    ? `AASC ${deps.version} · ${deps.lock.edition} · pid ${deps.lock.pid} · up ${uptime(deps.now() - deps.lock.startedAt)}`
    : `AASC ${deps.version} · not running`;
  const rows: [string, string][] = [['Data', tilde(deps.dataDir, deps.home)]];
  if (running) {
    rows.push(['Listening', `${bind}:${deps.port}${remotePort ? ` · remote-only 127.0.0.1:${remotePort}` : ''}`]);
    const reach = [
      addresses.tailnet && `Tailscale ${safeText(addresses.tailnet)}`,
      addresses.lan && `home network ${safeText(addresses.lan)}`,
      addresses.public && `public IP ${safeText(addresses.public)} (plain HTTP)`,
    ].filter(Boolean);
    rows.push(['Reachable', reach.length > 0 ? reach.join(' · ') : 'this machine only']);
  }
  rows.push(['Password', auth?.passwordRequired ?? config.passwordHash ? 'set · remote devices allowed' : 'not set · remote devices refused (run aasc-server set-password)']);
  if (running) {
    rows.push(['Sessions', sessionLine(sessions)]);
    rows.push(['Devices', deviceLine(devices)]);
  }
  rows.push(['Hooks', Object.entries(hooks).map(([cli, ok]) => `${cli} ${ok ? '✓' : '✗'}`).join(' · ') || 'none enabled']);
  if (cliAuth && cliAuth.clis.length > 0) rows.push(['Login', loginLine(cliAuth.clis)]);
  if (cloud === 'encrypted') rows.push(['Cloud', CLOUD_RECONNECT]);
  else if (cloud === 'damaged') rows.push(['Cloud', 'its saved sign-in is damaged: connect again from RESOURCES ▸ Cloud']);
  if (running) rows.push(['Automation', automation]);

  out(head);
  for (const [name, value] of rows) out(`${name.padEnd(10)} ${value}`);
  if (running && !writer) out(`\n${AUTOMATION_NOTE}`);
  return running ? EXIT.OK : EXIT.NOT_RUNNING;
}
