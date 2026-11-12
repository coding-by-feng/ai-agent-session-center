/**
 * @module hookQueueDir
 * The folder the hook scripts write their JSONL queue to, in one place (mqReader.ts and
 * planUsageSources.ts each had their own copy). Also where the machine lock lives (instanceLock.ts):
 * every AASC server on a machine reads this one queue, whatever its data folder.
 *
 * /tmp on macOS/Linux because a hook cannot predict os.tmpdir() (it is /var/folders/… on macOS);
 * dashboard-hook.sh and dashboard-statusline.sh hard-code the same path. On Windows the hooks use
 * $env:TEMP, which matches.
 *
 * AASC_TEST_QUEUE_DIR is for tests only. The hook scripts always write to the fixed path, so setting
 * it on a real server silently cuts that server off from every hook event.
 */
import { join } from 'path';

export function hookQueueDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.AASC_TEST_QUEUE_DIR) return env.AASC_TEST_QUEUE_DIR;
  return platform === 'win32'
    ? join(env.TEMP || env.TMP || 'C:\\Temp', 'claude-session-center')
    : '/tmp/claude-session-center';
}

/** The machine lock: one record of the AASC server reading this machine's hook queue. */
export function machineLockPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(hookQueueDir(env), 'server.lock');
}
