/** What every `aasc` command gets: the store, output, and the outside world it may touch (injected in tests). */
import { createInterface } from 'readline';
import type { FetchLike } from '../../electron/remote/remoteClient.js';
import type { SpawnLike } from './ssh.js';
import type { Store } from './store.js';

export interface Ctx {
  store: Store;
  out(line: string): void;
  err(line: string): void;
  /** y/N on the terminal; false when stdin isn't a terminal. */
  confirm(question: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  fetch?: FetchLike;
  spawn?: SpawnLike;
  env: NodeJS.ProcessEnv;
}

/** Ask a y/N question on the terminal. Anything but y/yes is no. */
export async function askYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => {
      // Ctrl-C at the prompt is a no (readline would otherwise just pause and hang).
      rl.once('SIGINT', () => { process.stderr.write('\n'); resolve(''); });
      rl.question(`${question} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function processCtx(store: Store): Ctx {
  return {
    store,
    out: (line) => { process.stdout.write(`${line}\n`); },
    err: (line) => { process.stderr.write(`${line}\n`); },
    confirm: askYesNo,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env: process.env,
  };
}
