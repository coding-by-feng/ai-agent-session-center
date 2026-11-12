// Run by test/aascCleanup.test.ts as its own process: opens a tunnel with the real spawn and
// the real exit hooks (PATH points `ssh` at fake-ssh.cjs), reports it, then idles until signalled.
import { openTunnel, parseSshTarget } from '../../../cli/client/ssh.js';

const tunnel = await openTunnel(parseSshTarget('me@box.example')!, { remotePort: 3333 });
process.stdout.write(`${JSON.stringify({ socketPath: tunnel.socketPath ?? null })}\n`);
setInterval(() => {}, 60_000);
