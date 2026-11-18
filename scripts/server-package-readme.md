# AI Agent Session Center: headless server

`aasc-server` runs AI Agent Session Center (AASC) on a machine with no desktop, such as a VPS or a home server. It watches the Claude Code and Codex sessions on that machine and lets you drive them from a browser, the AASC desktop app or the AASC phone app.

On a Mac or a PC with a screen, the desktop app is the easier way in: <https://aasc.work/download>.

## Install

You need Node.js 22.12.0 or later, `jq`, and Claude Code or the Codex CLI.

```bash
npm install -g ai-agent-session-center
```

`better-sqlite3` and `node-pty` are native modules. npm fetches prebuilt binaries where they exist; otherwise it compiles them, which needs a C++ toolchain.

## Set up and run

```bash
aasc-server setup             # the wizard, including the password a headless server needs
aasc-server doctor            # what this machine is missing, with the command that fixes each
aasc-server serve             # start the server (port 3333 by default; --port changes it)
aasc-server install-service   # Linux: a systemd user service that starts at boot
```

`aasc-server status` and `aasc-server logs` show what it is doing. `aasc-server help` lists every command.

## Connect a device

`aasc-server pair` prints a link and a text QR code. Open it from the phone app or the desktop app, then answer `y` on the server. `aasc-server devices` lists paired devices and revokes them.

## Security

A headless server refuses to start without a password. Anyone with the password can run terminals on this machine, so treat it like SSH access. The connection is plain HTTP: stay on a network you trust, or use a VPN such as Tailscale.

## Links

- Source and issues: <https://github.com/coding-by-feng/ai-agent-session-center>
- Website and docs: <https://aasc.work>

MIT license.
