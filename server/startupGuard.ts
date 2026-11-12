/**
 * @module startupGuard
 * The checks startServer() runs before it opens anything (terminal-editions plan §7.1):
 *
 *   1. headless with no password → exit 78 (D9: otherwise any local account, or an SSRF from a web
 *      app on the same box, drives the owner's terminals)
 *   2. the folder lock → exit 3 while a live server holds this data folder (every edition)
 *   3. headless only: the hook-queue folder must be ours and not a symlink → else exit 78 (our own
 *      folder with a looser mode is tightened to 0700)
 *   4. the machine lock → exit 3 while another AASC server reads this machine's hook queue, unless
 *      --allow-second-server. The desktop and a dev server write it but never refuse on it: a dev
 *      server beside the installed app is a normal setup on the Mac.
 *
 * Failures are thrown as StartupError; the caller decides how to exit (index.ts's auto-start exits
 * with the code, Electron shows the message). The systemd unit lists 78, 3 and 4 in
 * RestartPreventExitStatus, since none of them fixes itself; 1 (and a crash) is restarted.
 */
import { mkdirSync } from 'fs';
import { join } from 'path';
import { acquireLock, releaseLock, markLockListening, checkQueueDirOwnership, isLockLive, type Edition, type LockRecord } from './instanceLock.js';
import { setPasswordCommand } from './edition.js';

/** CONFIG is sysexits' EX_CONFIG: a refusal only the user can fix. FAILURE may fix itself on a retry. */
export const EXIT_CODES = { FAILURE: 1, LOCKED: 3, PORT_BUSY: 4, CONFIG: 78 } as const;

export class StartupError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'StartupError';
    this.exitCode = exitCode;
  }
}

export interface StartupGuardInput {
  port: number;
  edition: Edition;
  /** Where server-config.json lives; the folder lock goes beside it. */
  dataDir: string;
  /** The hook-queue folder (hookQueueDir.ts); the machine lock goes in it. */
  queueDir: string;
  passwordSet: boolean;
  allowSecondServer: boolean;
  /** process.getuid(), or null where there are no uids (Windows). */
  uid: number | null;
  isLive?: (holder: LockRecord) => Promise<boolean>;
  /** Told when the desktop/dev machine lock can't be written; that never stops their start. */
  warn?: (message: string) => void;
}

export interface StartupLocks {
  /** Remove whichever locks this process took. Safe to call more than once. */
  release(): void;
  /** After listen: mark both locks as serving on the address the server bound. */
  markListening(bindAddress: string): void;
}

function describe(holder: LockRecord): string {
  return `${holder.edition}, pid ${holder.pid}, :${holder.port}`;
}

export async function guardStartup(input: StartupGuardInput): Promise<StartupLocks> {
  const { edition, port, dataDir, queueDir } = input;
  const isLive = input.isLive ?? isLockLive;
  const headless = edition === 'headless';

  if (headless && !input.passwordSet) {
    throw new StartupError(
      EXIT_CODES.CONFIG,
      `A headless server needs a password: without one, any account on this machine can drive your terminals. Run \`${setPasswordCommand({ AASC_HEADLESS: '1' })}\`, then start it again.`,
    );
  }

  const record: LockRecord = { pid: process.pid, port, edition, startedAt: Date.now(), dataDir };
  const held: string[] = [];
  const release = (): void => {
    for (const path of held.splice(0)) releaseLock(path);
  };
  const markListening = (bindAddress: string): void => {
    for (const path of held) markLockListening(path, record, bindAddress);
  };

  const folderLock = join(dataDir, 'server.lock');
  try {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const folder = await acquireLock(folderLock, record, { isLive });
    if (!folder.acquired) {
      throw new StartupError(
        EXIT_CODES.LOCKED,
        `AASC is already running on this folder (pid ${folder.holder.pid}, :${folder.holder.port}): ${dataDir}`,
      );
    }
  } catch (err) {
    if (err instanceof StartupError) throw err;
    throw new StartupError(EXIT_CODES.FAILURE, `Cannot take the lock in ${dataDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  held.push(folderLock);

  const machineLock = join(queueDir, 'server.lock');
  if (!headless) {
    // Recorded so a headless server sees this one; a live holder's record is left as it is.
    try {
      mkdirSync(queueDir, { recursive: true, mode: 0o700 });
      if ((await acquireLock(machineLock, record, { isLive })).acquired) held.push(machineLock);
    } catch (err) {
      input.warn?.(`machine lock not written (${err instanceof Error ? err.message : String(err)})`);
    }
    return { release, markListening };
  }

  const refused = checkQueueDirOwnership(queueDir, { uid: input.uid });
  if (refused) {
    release();
    throw new StartupError(EXIT_CODES.CONFIG, `Refusing the hook queue folder: ${refused}. Remove it (or its symlink) so the server can create its own, then start again.`);
  }
  try {
    const machine = await acquireLock(machineLock, record, { isLive });
    if (machine.acquired) {
      held.push(machineLock);
    } else if (!input.allowSecondServer) {
      release();
      throw new StartupError(
        EXIT_CODES.LOCKED,
        `another AASC server is running on this machine (${describe(machine.holder)}) and reads the same hook queue. Stop it first, or pass --allow-second-server.`,
      );
    }
  } catch (err) {
    if (err instanceof StartupError) throw err;
    release();
    throw new StartupError(EXIT_CODES.FAILURE, `Cannot take the machine lock in ${queueDir}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { release, markListening };
}
