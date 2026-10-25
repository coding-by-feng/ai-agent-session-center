// lanAdvertiser.ts — tell phones on this Wi-Fi where the Mac is (Bonjour `_aasc._tcp`).
//
// A paired phone keeps the Mac's home-network address from the pairing QR. When
// that address changes (a new DHCP lease, another network), the phone browses
// for this service (mobile/shell/src/lanRescan.ts) and opens what it finds only
// after the Mac there proves it holds the phone's key (POST /api/mobile/identify).
// So the advertisement says nothing but a name and a port.
//
// The system's own responder does the work: `dns-sd -R` on macOS (mDNSResponder
// follows address changes by itself), `avahi-publish -s` on Linux when installed,
// nothing elsewhere. It runs under a small sh watchdog that ends it when this
// process's pipe closes, so a crashed or killed server leaves no advertisement.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export const AASC_SERVICE_TYPE = '_aasc._tcp';
/** TXT record: the advertisement's version. */
const TXT = 'v=1';
/** A DNS-SD instance name is one DNS label. */
const MAX_INSTANCE_BYTES = 63;
export const RESTART_DELAY_MS = 30_000;
/** An advertiser that keeps dying is left off after this many restarts in a row (a run that lasted resets the count). */
export const MAX_RESTARTS = 5;
/** sh's "command not found". */
const NOT_INSTALLED = 127;

/**
 * Runs "$@" (the advertiser) and kills it once our end of fd 0 closes: a
 * background job's own stdin is /dev/null in sh, so the pipe is kept on fd 3
 * for the reader. Exits with the advertiser's status, 127 when it is missing.
 */
export const WATCHDOG_SCRIPT =
  'exec 3<&0; "$@" </dev/null >/dev/null 2>&1 & p=$!; (cat <&3 >/dev/null 2>&1; kill "$p" 2>/dev/null) & wait "$p"';

/** Control characters out, at most one DNS label of UTF-8, never empty. */
export function serviceInstanceName(raw: string): string {
  const clean = raw.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim();
  let out = '';
  for (const ch of clean) {
    if (Buffer.byteLength(out + ch, 'utf8') > MAX_INSTANCE_BYTES) break;
    out += ch;
  }
  return out.trim() || 'AASC';
}

export function advertiseCommand(platform: NodeJS.Platform, name: string, port: number): { cmd: string; args: string[] } | null {
  if (platform === 'darwin') return { cmd: 'dns-sd', args: ['-R', name, AASC_SERVICE_TYPE, 'local', String(port), TXT] };
  if (platform === 'linux') return { cmd: 'avahi-publish', args: ['-s', name, AASC_SERVICE_TYPE, String(port), TXT] };
  return null;
}

/**
 * Only while a phone could use it: every phone route needs the dashboard
 * password, and there must be a phone to find the Mac (paired already) or one
 * that can pair (pairing offered, AASC-30).
 */
export function shouldAdvertise(state: { passwordEnabled: boolean; pairingOffered: boolean; activePhones: number }): boolean {
  return state.passwordEnabled && (state.pairingOffered || state.activePhones > 0);
}

export interface LanAdvertiserOptions {
  name: string;
  port: number;
  platform?: NodeJS.Platform;
  spawn?: typeof nodeSpawn;
  log: { info(message: string): void; warn(message: string): void; debug(message: string): void };
}

export function startLanAdvertiser(opts: LanAdvertiserOptions): { stop(): void } {
  const spawn = opts.spawn ?? nodeSpawn;
  const name = serviceInstanceName(opts.name);
  const command = advertiseCommand(opts.platform ?? process.platform, name, opts.port);
  if (!command) return { stop: () => undefined };
  let child: ChildProcess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let restarts = 0;

  const run = (): void => {
    timer = null;
    const startedAt = Date.now();
    const proc = spawn('/bin/sh', ['-c', WATCHDOG_SCRIPT, 'aasc-lan-advertiser', command.cmd, ...command.args], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child = proc;
    proc.stdin?.on('error', () => undefined); // EPIPE once the watchdog has gone
    proc.on('error', (err: Error) => opts.log.debug(`Bonjour advertiser failed to start: ${err.message}`));
    proc.on('exit', (code) => {
      proc.stdin?.destroy(); // the watchdog's reader, if still waiting, ends too
      if (child === proc) child = null;
      if (stopped) return;
      if (Date.now() - startedAt >= RESTART_DELAY_MS) restarts = 0;
      if (code === NOT_INSTALLED) {
        opts.log.debug(`${command.cmd} is not installed: phones can't find this Mac by Bonjour, only at its saved address`);
        return;
      }
      if (restarts >= MAX_RESTARTS) {
        opts.log.warn(`Bonjour advertiser kept stopping (${command.cmd} exit ${code ?? 'signal'}); phones won't find this Mac by Bonjour until AASC restarts`);
        return;
      }
      restarts += 1;
      timer = setTimeout(run, RESTART_DELAY_MS);
      timer.unref?.();
    });
  };

  run();
  opts.log.info(`Phones on this network can find ${name} by Bonjour (${AASC_SERVICE_TYPE}, port ${opts.port})`);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (child) {
        child.stdin?.end(); // the watchdog kills the advertiser
        child.kill('SIGTERM');
        child = null;
      }
    },
  };
}
