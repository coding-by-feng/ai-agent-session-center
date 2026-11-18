# aasc: the AASC terminal client

`aasc` lists, attaches to, sends to and watches AI agent sessions (Claude Code and Codex) running on an [AI Agent Session Center](https://aasc.work) server, from any terminal. It has no dependencies and runs nothing on the server's behalf: the sessions stay where the server is.

## Install

You need Node.js 22.12 or later.

```bash
npm install -g aasc
```

The server is the AASC desktop app, or `aasc-server` from the `ai-agent-session-center` package on a machine with no desktop.

## Connect

Pair with a link the server prints (`aasc-server pair`, or Pair a phone or computer in the desktop app), then allow this computer on the server:

```bash
aasc add '<pairing link>' --name vps
```

Or, when you can already SSH into the server, skip pairing:

```bash
aasc add --ssh you@host --name vps
```

## Use

```bash
aasc ls                      # sessions and their status
aasc attach 2                # this terminal on session 2's; Ctrl-] detaches
aasc send 2 "run the tests"  # type a prompt and press Enter
aasc queue 2 "then deploy"   # add a paused item to the session's queue
aasc watch --notify          # status changes as they happen; bell on approval or input
aasc open                    # the server's web UI in your browser
aasc servers                 # the servers added here
aasc remove vps              # unpair and forget a server
```

A session is its number in the last `aasc ls`, an id prefix, or words from its title. With several servers, prefix the server: `vps:2`.

## Security

A paired computer sees only the sessions the server shares with it. Keys are stored in `~/.config/aasc` (mode 0700). A pairing link's public address is plain HTTP over the Internet and is refused unless you pass `--insecure`; prefer a home network, Tailscale or `--ssh`.

## Links

- Source and issues: <https://github.com/coding-by-feng/ai-agent-session-center>
- Website and docs: <https://aasc.work>

MIT license.
