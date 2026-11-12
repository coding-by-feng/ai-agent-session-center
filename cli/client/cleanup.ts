/**
 * The one place `aasc` hooks process exit and the signals that end a CLI. A default SIGINT,
 * SIGTERM or SIGHUP kills Node without firing 'exit', which would orphan an `ssh -N` tunnel
 * and leave a raw-mode terminal behind. So: run every registered cleanup, then exit
 * 128 + the signal number, the shell convention. Cleanups run once, newest first.
 */
const SIGNAL_EXIT: Record<'SIGHUP' | 'SIGINT' | 'SIGTERM', number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

const cleanups = new Set<() => void>();
let installed = false;

function runAll(): void {
  const fns = [...cleanups].reverse();
  cleanups.clear();
  for (const fn of fns) {
    try { fn(); } catch { /* one failed cleanup must not stop the others */ }
  }
}

function onSignal(signal: NodeJS.Signals): void {
  runAll();
  process.exit(SIGNAL_EXIT[signal as keyof typeof SIGNAL_EXIT] ?? 1);
}

function install(): void {
  if (installed) return;
  installed = true;
  process.on('exit', runAll);
  for (const signal of Object.keys(SIGNAL_EXIT) as NodeJS.Signals[]) process.on(signal, onSignal);
}

/** Run `fn` when the process exits or is signalled; returns the unregister. */
export function onCleanup(fn: () => void): () => void {
  install();
  cleanups.add(fn);
  return () => { cleanups.delete(fn); };
}

/** Test seam: remove the process hooks and forget every cleanup. */
export function _resetCleanupForTests(): void {
  cleanups.clear();
  if (!installed) return;
  installed = false;
  process.off('exit', runAll);
  for (const signal of Object.keys(SIGNAL_EXIT) as NodeJS.Signals[]) process.off(signal, onSignal);
}
