// keepAwakeHolder.ts — keep this computer awake where no desktop window holds a power blocker (Nov 27 2026):
// `aasc-server`, `npm start`, the npm package. One child process per hold, from the platform's own tool, that
// ends when this server does (it watches our pid), so a crash never leaves the computer unable to sleep:
//   macOS    caffeinate -i -s -w <pid>      no idle sleep; no system sleep on mains power
//   Linux    systemd-inhibit --what=idle:sleep … tail --pid=<pid> -f /dev/null
//   Windows  powershell: SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED), then Wait-Process <pid>
// No administrator password, nothing changed system-wide: a closed laptop lid on battery may still sleep, as
// the desktop app's blocker allows. A missing tool is logged once and the server runs on.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export interface HolderCommand {
  command: string;
  args: string[];
}

/** The platform's hold-awake command, watching `pid`; null where there is none. */
export function holderCommand(platform: NodeJS.Platform, pid: number): HolderCommand | null {
  switch (platform) {
    case 'darwin':
      return { command: 'caffeinate', args: ['-i', '-s', '-w', String(pid)] };
    case 'linux':
      return {
        command: 'systemd-inhibit',
        args: ['--what=idle:sleep', '--who=AI Agent Session Center', '--why=Keep this computer awake (AASC setting)', '--mode=block', 'tail', `--pid=${pid}`, '-f', '/dev/null'],
      };
    case 'win32': {
      const script = [
        "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
        'Add-Type -MemberDefinition $sig -Name Power -Namespace Aasc | Out-Null',
        '[Aasc.Power]::SetThreadExecutionState(0x80000001) | Out-Null',
        `Wait-Process -Id ${pid}`,
      ].join('; ');
      return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
    }
    default:
      return null;
  }
}

type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface SleepHolderDeps {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: Spawn;
  log?: { info(context: string, message: string): void; warn(context: string, message: string): void };
}

export interface SleepHolder {
  /** Hold (true) or let go (false); repeating either is a no-op. */
  set(awake: boolean): void;
  isHolding(): boolean;
}

export function createSleepHolder(deps: SleepHolderDeps = {}): SleepHolder {
  const platform = deps.platform ?? process.platform;
  const pid = deps.pid ?? process.pid;
  const spawn: Spawn = deps.spawn ?? ((c, a, o) => nodeSpawn(c, a, o));
  let child: ChildProcess | null = null;
  let warned = false;

  const warnOnce = (message: string) => {
    if (warned) return;
    warned = true;
    deps.log?.warn('keep-awake', message);
  };

  function start(): void {
    const cmd = holderCommand(platform, pid);
    if (!cmd) {
      warnOnce(`Keeping this computer awake isn't supported on ${platform}.`);
      return;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(cmd.command, cmd.args, { stdio: 'ignore', windowsHide: true });
    } catch (err) {
      warnOnce(`Couldn't start ${cmd.command} to keep this computer awake: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    child = proc;
    proc.on('error', (err) => {
      warnOnce(`Couldn't start ${cmd.command} to keep this computer awake: ${err.message}`);
      if (child === proc) child = null;
    });
    proc.on('exit', (code, signal) => {
      if (child !== proc) return; // we stopped it ourselves
      child = null;
      // It ended on its own: refused (no logind in a container, a policy) or killed. Say so, or "always" holds nothing silently.
      warnOnce(`${cmd.command} stopped (${code !== null ? `exit ${code}` : `signal ${signal ?? 'unknown'}`}); this computer may sleep.`);
    });
    proc.unref();
    deps.log?.info('keep-awake', `Keeping this computer awake (${cmd.command})`);
  }

  function stop(): void {
    const proc = child;
    child = null;
    if (!proc) return;
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
    deps.log?.info('keep-awake', 'This computer may sleep again');
  }

  return {
    set(awake) {
      if (awake && !child) start();
      else if (!awake && child) stop();
    },
    isHolding: () => child !== null,
  };
}
