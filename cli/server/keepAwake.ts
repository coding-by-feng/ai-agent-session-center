/**
 * `aasc-server keep-awake [off|busy|always|status] [--json]` (Nov 27 2026): keep this box from sleeping.
 *
 * Setup asks it first; this changes it later. A desktop has Settings for it; a headless server has no screen,
 * so this is its switch. It reads and writes the running server's setting (GET/POST /api/config/keep-awake,
 * this machine only), which saves it in server-config.json and applies it at once: the server holds the
 * platform's own tool (caffeinate, systemd-inhibit, a Windows power request) and lets go when it stops.
 */
import { EXIT, errorOf, type AdminClient } from './http.js';

export interface KeepAwakeDeps {
  client: AdminClient;
  /** What follows `keep-awake`: [], ['status'], ['off'], ['busy'] or ['always']. */
  args: string[];
  json: boolean;
  out: (line: string) => void;
}

const USAGE = 'Usage: aasc-server keep-awake off|busy|always|status [--json]';
const MODES = ['off', 'busy', 'always'] as const;
type Mode = (typeof MODES)[number];

const WORDS: Record<Mode, string> = {
  off: 'off: this box sleeps as usual.',
  busy: 'while an agent is busy: awake while an agent works or waits for you.',
  always: 'always: awake for as long as the server runs.',
};

function report(body: Record<string, unknown> | undefined, deps: KeepAwakeDeps): number {
  const mode = MODES.find((m) => m === body?.mode);
  if (!mode) {
    deps.out('The server sent an answer this command does not understand. Is it the same version?');
    return EXIT.FAILED;
  }
  const awake = body?.awake === true;
  // An older server sends no `holding`: then being awake is all it can say.
  const holding = typeof body?.holding === 'boolean' ? body.holding : awake;
  if (deps.json) {
    deps.out(JSON.stringify({ mode, awake, holding }, null, 2));
    return EXIT.OK;
  }
  deps.out(`Keep awake: ${WORDS[mode]}`);
  deps.out(
    !awake ? '  Not holding it awake now.'
      : holding ? '  Holding this box awake now.'
        : '  Should be holding this box awake, but the keep-awake helper stopped. The server log says why; choose the mode again to retry.',
  );
  return EXIT.OK;
}

export async function runKeepAwake(deps: KeepAwakeDeps): Promise<number> {
  const [action = 'status', ...extra] = deps.args;
  if (extra.length > 0 || !['status', ...MODES].includes(action)) {
    deps.out(USAGE);
    return EXIT.USAGE;
  }
  const res = action === 'status'
    ? await deps.client.request('GET', '/api/config/keep-awake')
    : await deps.client.request('POST', '/api/config/keep-awake', { mode: action });
  if (res.status !== 200) {
    deps.out(errorOf(res, action === 'status' ? 'Could not read the setting' : 'Could not save the setting'));
    return EXIT.FAILED;
  }
  return report((res.body as { data?: Record<string, unknown> } | undefined)?.data, deps);
}
