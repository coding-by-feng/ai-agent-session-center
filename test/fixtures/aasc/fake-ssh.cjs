#!/usr/bin/env node
// A pretend `ssh -N -L <socket>:127.0.0.1:<port> …` for test/aascCleanup.test.ts: it binds the
// local end of the forward and then idles, like the real one. Never a real connection.
const net = require('net');
const fs = require('fs');
const args = process.argv.slice(2);
const forward = args[args.indexOf('-L') + 1];
const socketPath = forward.slice(0, forward.indexOf(':127.0.0.1:'));
fs.writeFileSync(process.env.FAKE_SSH_PID_FILE, String(process.pid));
net.createServer((c) => c.end()).listen(socketPath);
setInterval(() => {}, 60_000);
