/** The `aasc` executable: run one command, then exit with its code (the ssh children die with us). */
import { main } from './index.js';

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
  // A finished command must not linger on sockets or timers, but piped output (ls --json | jq)
  // is written asynchronously: exit only once stdout and stderr have drained.
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
});
