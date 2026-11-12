/**
 * `aasc-server share-default [on|off|status] [--json]` (Oct 29 2026): should sessions that appear on this
 * box start shared with the paired devices?
 *
 * A session a device starts from its own dashboard is already shared with it. This covers the rest: a
 * `claude` run over ssh or in a terminal on the box. On a desktop the Mac's Settings toggle does it; a
 * headless server has no screen, so this is its only switch. It reads and writes the running server's
 * setting (GET/PUT /api/sharing-default, this machine only), which saves it in <data>/share-default.json.
 */
import { EXIT, errorOf, type AdminClient } from './http.js';

export interface ShareDefaultDeps {
  client: AdminClient;
  /** What follows `share-default`: [], ['status'], ['on'] or ['off']. */
  args: string[];
  json: boolean;
  out: (line: string) => void;
}

const USAGE = 'Usage: aasc-server share-default on|off|status [--json]';

function report(on: boolean, deps: ShareDefaultDeps): void {
  if (deps.json) {
    deps.out(JSON.stringify({ shareNewSessions: on }, null, 2));
    return;
  }
  deps.out(`Share new sessions: ${on ? 'on' : 'off'}`);
  deps.out(on
    ? '  Every session that appears on this server from now on shows on every paired phone and computer.'
    : '  A session started on this server (over ssh, in a terminal) stays hidden from your devices. One a device starts is shared with it.');
}

export async function runShareDefault(deps: ShareDefaultDeps): Promise<number> {
  const [action = 'status', ...extra] = deps.args;
  if (extra.length > 0 || !['status', 'on', 'off'].includes(action)) {
    deps.out(USAGE);
    return EXIT.USAGE;
  }

  if (action === 'status') {
    const res = await deps.client.request('GET', '/api/sharing-default');
    if (res.status !== 200) {
      deps.out(errorOf(res, 'Could not read the setting'));
      return EXIT.FAILED;
    }
    report(res.body?.shareNewSessions === true, deps);
    return EXIT.OK;
  }

  const on = action === 'on';
  const res = await deps.client.request('PUT', '/api/sharing-default', { shareNewSessions: on });
  if (res.status !== 200) {
    deps.out(errorOf(res, 'Could not save the setting'));
    return EXIT.FAILED;
  }
  report(res.body?.shareNewSessions === true, deps);
  if (on && !deps.json) deps.out('  Sessions already running stay as they are: share one from its panel in a dashboard.');
  return EXIT.OK;
}
