/**
 * `aasc-server devices [--json]`, `devices revoke <id>`, `devices rename <id> <name>`
 * (terminal-editions plan §8.1, §8.4): the paired phones and computers, as the desktop's Settings
 * list them. Revoking closes the device's sockets at once (deviceAuth's onRevoked).
 *
 * <id> is any unique prefix of the id, so the 8 characters the list shows are enough.
 */
import { EXIT, errorOf, safeText, type AdminClient } from './http.js';

interface DeviceRow {
  id: string;
  label: string;
  platform: string;
  status: string;
  confirmCode: string | null;
  lastSeenAt: number | null;
  online?: boolean;
}

export interface DevicesDeps {
  client: AdminClient;
  /** What follows `devices`: [] to list, ['revoke', id] or ['rename', id, name]. */
  args: string[];
  json: boolean;
  out: (line: string) => void;
  now: () => number;
}

export const kindOf = (platform: string): string => (platform === 'desktop' ? 'computer' : 'phone');

function statusOf(d: DeviceRow): string {
  if (d.status === 'pending') return 'waiting for Allow';
  return d.online ? 'online' : 'paired';
}

export function ago(at: number | null, now: number): string {
  if (at === null) return '—';
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function table(rows: string[][]): string[] {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => r[col].length)));
  return rows.map((r) => r.map((cell, col) => (col === r.length - 1 ? cell : cell.padEnd(widths[col]))).join('  '));
}

export async function fetchDevices(client: AdminClient): Promise<DeviceRow[] | string> {
  const res = await client.request('GET', '/api/mobile/devices');
  if (res.status !== 200) return errorOf(res, 'Could not list devices');
  return (res.body?.data?.devices ?? []) as DeviceRow[];
}

function findOne(devices: DeviceRow[], prefix: string): DeviceRow | string {
  if (!prefix) return 'Name a device by its ID (see `aasc-server devices`).';
  const matches = devices.filter((d) => d.id.startsWith(prefix));
  if (matches.length === 0) return `No paired device has an ID starting ${safeText(prefix)}.`;
  if (matches.length > 1) return `${matches.length} devices have an ID starting ${safeText(prefix)}: give more of it.`;
  return matches[0];
}

export async function runDevices(deps: DevicesDeps): Promise<number> {
  const { client, out } = deps;
  const devices = await fetchDevices(client);
  if (typeof devices === 'string') {
    out(devices);
    return EXIT.FAILED;
  }
  const [action, idPrefix = '', ...name] = deps.args;

  if (action === undefined) {
    if (deps.json) {
      out(JSON.stringify({ devices }, null, 2));
      return EXIT.OK;
    }
    if (devices.length === 0) {
      out('No paired devices. Pair one with `aasc-server pair`.');
      return EXIT.OK;
    }
    const rows = [['ID', 'NAME', 'KIND', 'STATUS', 'LAST SEEN'], ...devices.map((d) => [
      safeText(d.id).slice(0, 8), safeText(d.label), kindOf(d.platform), statusOf(d), d.status === 'pending' ? '—' : ago(d.lastSeenAt, deps.now()),
    ])];
    for (const line of table(rows)) out(line);
    return EXIT.OK;
  }

  if (action !== 'revoke' && action !== 'rename') {
    out(`Unknown devices command "${safeText(action)}". Use: devices, devices revoke <id>, devices rename <id> <name>.`);
    return EXIT.FAILED;
  }
  const device = findOne(devices, idPrefix);
  if (typeof device === 'string') {
    out(device);
    return EXIT.FAILED;
  }
  const path = `/api/mobile/devices/${encodeURIComponent(device.id)}`;
  const label = safeText(device.label);

  if (action === 'revoke') {
    const res = await client.request('DELETE', path);
    if (res.status !== 200) {
      out(errorOf(res, `Could not revoke ${label}`));
      return EXIT.FAILED;
    }
    out(`✓ Revoked ${label}. Its connections were closed.`);
    return EXIT.OK;
  }

  const newName = name.join(' ').trim();
  if (!newName) {
    out('Give the new name: devices rename <id> <name>.');
    return EXIT.FAILED;
  }
  const res = await client.request('PATCH', path, { label: newName });
  if (res.status !== 200) {
    out(errorOf(res, `Could not rename ${label}`));
    return EXIT.FAILED;
  }
  out(`✓ Renamed ${label} to ${safeText(newName)}.`);
  return EXIT.OK;
}
