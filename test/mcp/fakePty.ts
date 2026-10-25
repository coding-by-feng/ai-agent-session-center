// test/mcp/fakePty.ts — a stand-in for node-pty, so no test in this folder starts a real shell.
//
// A test file installs it with
//   vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);
// and reads what the code under test did through `spawned`: the environment each PTY was spawned
// with, every byte typed into it, and `exit()` to play the PTY ending.
import { vi } from 'vitest';

type DataHandler = (data: string) => void;
type ExitHandler = (event: { exitCode: number; signal?: number }) => void;

export interface FakePty {
  /** Invented, above any real pid range, so nothing that is handed it can reach a real process. */
  pid: number;
  cols: number;
  rows: number;
  /** What it was spawned as: `pty.spawn(file, args, { env })`. */
  file: string;
  args: string[];
  env: Record<string, string>;
  /** Everything written into it, in order. */
  typed: string[];
  kill: ReturnType<typeof vi.fn>;
  resize: () => void;
  write: (data: string) => void;
  onData: (handler: DataHandler) => { dispose: () => void };
  onExit: (handler: ExitHandler) => { dispose: () => void };
  /** Play the PTY exiting: every exit handler still registered is called. */
  exit: (exitCode?: number, signal?: number) => void;
}

/** Every PTY spawned since the last `resetFakePtys()`, oldest first. */
export const spawned: FakePty[] = [];

/** The most recent PTY. */
export function lastPty(): FakePty {
  const pty = spawned[spawned.length - 1];
  if (pty === undefined) throw new Error('No PTY has been spawned');
  return pty;
}

export function resetFakePtys(): void {
  spawned.length = 0;
}

function makeFakePty(
  file: string,
  args: string[],
  opts: { env?: Record<string, string> },
): FakePty {
  const dataHandlers = new Set<DataHandler>();
  const exitHandlers = new Set<ExitHandler>();
  const typed: string[] = [];
  const pty: FakePty = {
    pid: 4_200_000 + spawned.length,
    cols: 120,
    rows: 40,
    file,
    args,
    env: { ...(opts.env ?? {}) },
    typed,
    kill: vi.fn(),
    resize: () => {},
    write: (data) => {
      typed.push(data);
    },
    onData: (handler) => {
      dataHandlers.add(handler);
      return { dispose: () => void dataHandlers.delete(handler) };
    },
    onExit: (handler) => {
      exitHandlers.add(handler);
      return { dispose: () => void exitHandlers.delete(handler) };
    },
    exit: (exitCode = 0, signal) => {
      for (const handler of [...exitHandlers]) handler({ exitCode, signal });
    },
  };
  return pty;
}

/** What `vi.mock('node-pty', …)` returns: the module's default export, with `spawn` recording each PTY. */
export const nodePtyModule = {
  default: {
    spawn: vi.fn((file: string, args: string[], opts: { env?: Record<string, string> }) => {
      const pty = makeFakePty(file, args, opts);
      spawned.push(pty);
      return pty;
    }),
  },
};
