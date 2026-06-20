# AI Agent Session Center

**Monitor, drive, queue, and resume every Claude Code, Gemini, and Codex session from one localhost dashboard — each rendered as a live 3D robot you can click into.**

*Built for developers juggling multiple AI coding agents across terminals and machines.*

[![npm version](https://img.shields.io/npm/v/ai-agent-session-center.svg)](https://www.npmjs.com/package/ai-agent-session-center)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)

### **[▶ Try it live — zero install, runs in your browser → aasc.work/demo](https://aasc.work/demo)**

<img src="static/screenshot-dashboard.png" alt="3D cyberdrome with active agent sessions across project rooms" width="100%">

**Jump to:** [Install](#install) · [Why power users keep it open](#why-power-users-keep-it-open) · [What's inside](#whats-inside) · [Under the hood](#under-the-hood) · [Commands](#commands) · [Troubleshooting](#troubleshooting) · [FAQ](#faq)

> You're running Claude Code in one terminal, Gemini in another, Codex in a third. Which one is **stuck waiting for approval**? Which one **finished** and needs your next prompt? Which one is **burning tokens on a runaway loop**? Agent Session Center watches all of them at once and surfaces the one that needs you — so you stop tab-juggling and only step in when it matters.

```bash
npx ai-agent-session-center
```

The dashboard opens at **http://localhost:3333** and registers lightweight, read-only hooks automatically — no manual config, fully reversible with `--uninstall`. Robots appear the moment you use any AI CLI in any terminal.

Not ready to install? **[Try the live demo first — no setup → aasc.work/demo](https://aasc.work/demo)**

---

## Why power users keep it open

A control plane for serious multi-agent work — built to be left open all day.

| Without it | With Agent Session Center |
|------------|---------------------------|
| Alt-tab through a wall of terminals to find the blocked one | The robot that needs you flashes, alarms, and surfaces a colored alert card |
| Copy-paste prompts into whichever window is free | Queue prompts per session and auto-fire them the moment it goes idle |
| Babysit long runs so you don't miss the approval prompt | Walk away — scheduled loops and quiet-hours windows run hands-off |
| Lose your whole layout when a session or machine restarts | Workspace snapshots rebuild sessions, tabs, rooms, and scrollback |

- **One dashboard replaces a wall of terminals.** Monitor and drive every Claude Code, Gemini, and Codex session across local and remote machines — live terminals, full conversation transcripts, tool logs, and a file browser, in one view.
- **Drive agents from live terminals — even on a second monitor.** Real xterm.js terminals with SSH/tmux support, and you can pop any terminal or project panel out into its own native desktop window and fling it to another display.
- **Select-to-explain, anywhere.** Highlight text in any terminal or transcript and fork a floating picture-in-picture AI session to explain, translate, or define it.
- **Engineered for always-on use.** 3–17ms hook-to-screen latency, 700+ Vitest tests, a native Electron desktop app, and a fully mobile-responsive browser UI.

---

## See it

### Walkthrough video

https://github.com/user-attachments/assets/004ee6f9-942c-44c2-a4c5-d971fa0e824b

### Desktop

<table>
  <tr>
    <td><img src="static/screenshot-terminal.png" alt="Live terminal session — drive agents straight from the dashboard" width="400"></td>
    <td><img src="static/screenshot-project-tab-detailed.png" alt="Split view, detailed session switcher — terminal and project file browser side by side" width="400"></td>
  </tr>
</table>

### Mobile

<table>
  <tr>
    <td><img src="static/screenshot-mobile-home.png" alt="Mobile — 3D cyberdrome with session list" width="160"></td>
    <td><img src="static/screenshot-mobile-terminal.png" alt="Mobile — terminal tab with live conversation" width="160"></td>
    <td><img src="static/screenshot-mobile-project.png" alt="Mobile — project file browser" width="160"></td>
    <td><img src="static/screenshot-mobile-history.png" alt="Mobile — session history with filters" width="160"></td>
  </tr>
</table>

---

## Install

```bash
npx ai-agent-session-center
```

That's the happy path. The dashboard starts at **http://localhost:3333** (configurable) and configures hooks automatically.

**What it changes on your machine:** read-only hook entries added to your AI CLI settings (e.g. `~/.claude/settings.json`, via atomic write) and a queue file under `/tmp/claude-session-center/`. Nothing in the CLIs themselves is modified, and it's fully reversible with `--uninstall`.

<details>
<summary><b>Other install options</b></summary>

### Global install

```bash
npm install -g ai-agent-session-center
ai-agent-session-center
```

### From source

```bash
git clone https://github.com/coding-by-feng/ai-agent-session-center.git
cd ai-agent-session-center
npm install
npm run dev
```

### Uninstall

```bash
# Remove hooks from all CLI configs
npx ai-agent-session-center --uninstall

# If installed globally
npm uninstall -g ai-agent-session-center
```

</details>

### Requirements

- **Node.js 18+** with npm
- **jq** (recommended) for hook enrichment — hooks still work without it, with less metadata
- One or more supported AI CLIs:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
  - [Gemini CLI](https://github.com/google-gemini/gemini-cli)
  - [Codex CLI](https://github.com/openai/codex)

### First run

1. Start the dashboard — robots appear automatically as you use AI CLIs in any terminal.
2. Click **+ New** to spawn local or SSH terminal sessions directly from the dashboard.
3. Click a robot to open its detail panel (Project, Terminal, Commands, Conversation, AI Popups, Notes, Queue).
4. Queue prompts, assign sessions to rooms, and open **Settings** to tune themes, sounds, and hook density.

### CLI options

```bash
ai-agent-session-center [options]

Options:
  --port <number>    Server port (default: 3333)
  --no-open          Don't auto-open browser
  --debug            Enable verbose logging
  --setup            Re-run the interactive setup wizard
  --uninstall        Remove all hooks from CLI configs and exit
```

---

## What's inside

A quick tour. The complete reference — 45 feature docs with architecture and APIs — lives in [`docs/feature/README.md`](docs/feature/README.md).

- **3D cyberdrome** — 6 procedural robot models, 8 animation states, user-created project rooms plus a coffee lounge with spatial navigation, subagent laser-link beams, camera fly-to, and a 2D flat-list fallback.
- **Session detail panel** — a resizable 7-tab panel (Project, Terminal, Commands, Conversation, AI Popups, Notes, Queue), session switcher, inline-edit title/label/accent color, and split view.
- **Terminal & SSH** — xterm.js with local/SSH/tmux sessions, dual transport (IPC in Electron / WebSocket in browser), `claude --resume`, pop-out to native desktop windows, bookmarks, select-to-explain, and hold-to-speak text-to-speech.
- **Project browser** — lazy file tree, fuzzy find over a cached index, syntax highlighting, image/TeX viewers, inline editing, and `/`-command + `@`-file autocomplete.
- **Multi-CLI monitoring** — automatically links every hook event to the right terminal session with no per-session setup, via an **8-priority matching cascade** (display-only fallback when nothing matches). Works with Claude Code, Gemini, and Codex, with `--model` / `--effort` launch flags.
- **Queue, scheduler & loops** — a global and per-session queue with drag-reorder, auto-send-on-idle, scheduled loops with quiet-hours windows, and exportable queue history.
- **Workspace snapshots** — full layout serialization, 10s server auto-snapshots, SSH auto-respawn on restart, and seamless session-ID re-keying on resume.
- **History & search** — full-text history search across titles, projects, and labels, with date, status, and sort filters.
- **Theming & sound** — **9 scene themes**, **15 synthesized event sounds** with per-CLI profiles, **5 ambient presets**, and CRT/scanline + particle effects.
- **Security** — optional password login (rate-limited), a localhost-only hook endpoint, and directory-traversal + SSH-injection guards.
- **Desktop & mobile** — a native Electron app (macOS first-class, Windows supported; system tray, multi-window) plus a fully responsive browser UI that runs anywhere Node does.

---

## Session state machine

| Status | What it means | Visual |
|--------|---------------|--------|
| **Idle** | No activity | Green, robot seeks coffee lounge |
| **Prompting** | You just sent a prompt | Cyan, robot walks to its desk |
| **Working** | Agent is calling tools | Orange, charging effect |
| **Waiting** | Agent finished, your turn | Cyan, robot heads to the coffee lounge |
| **Approval** | Tool blocked, needs yes/no | Yellow, visor flash, alarm |
| **Input** | Waiting for your answer | Purple, arm raised |
| **Ended** | Session closed | Red, offline animation |

---

## Under the hood

Lightweight bash hooks append JSON events to a file-based message queue (`/tmp/claude-session-center/queue.jsonl`). The server watches the file and broadcasts updates to connected browsers over WebSocket. No CLI is modified — the hooks are purely observational and add ~2–5ms per event. **End-to-end latency is 3–17ms** from hook fired to browser updated (measured locally; the upper bound includes the React render and 3D scene update).

```
AI CLI (Claude / Gemini / Codex)
         |
    Hook script (bash)                    ~2-5ms
    - enriches with PID, TTY, terminal env
         |
  /tmp/.../queue.jsonl                    ~0.1ms
  - atomic POSIX append
         |
  Server (Express + WebSocket)            ~0.5ms
  - validate, process, broadcast
         |
  React frontend                          + render
  - 3D scene + detail panels update
```

### Session matching

Each hook event is linked to the right terminal session via an **8-priority fallback cascade** — pending-resume, terminal-ID, working-directory, path-scan, and PID-parent strategies, plus fork-routing and PID-cache sub-steps. If nothing matches, a display-only card is created with the detected source (VS Code, iTerm, Warp, Ghostty, etc.).

### Hook density levels

| Level | Behavior |
|-------|----------|
| high | All Claude hook events — fullest monitoring and approval detection |
| medium | Default — good balance of detail and overhead |
| low | Minimal event set for the lowest overhead |

### Tech stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js 18+ (ESM), Express 5, ws 8, tsx |
| Frontend | React 19, TypeScript, Vite 7, Zustand 5, @tanstack/react-query 5 |
| 3D | Three.js 0.182, @react-three/fiber 9, @react-three/drei 10 |
| Terminal | @xterm/xterm 5.5 (+ fit, unicode11, web-links), node-pty 1.1 |
| Desktop | Electron 34, electron-builder 25 |
| Database | better-sqlite3 12 (WAL) + Dexie 4 (IndexedDB, 15 tables) |
| Forms / validation | react-hook-form 7 + Zod 4 |
| Markdown | react-markdown 10 + rehype-highlight |
| Routing / misc | react-router 7 · latex.js · xlsx · auto-launch |
| Testing | Vitest 4 (700+ tests) + Playwright 1.58 (E2E) |

---

## Commands

```bash
npm run dev              # Development (Vite HMR + backend)
npm run build            # Build frontend for production
npm start                # Start production server
npm run setup            # Interactive setup wizard
npm run install-hooks    # Install hooks into CLI configs
npm run uninstall-hooks  # Remove all dashboard hooks
npm run reset            # Reset everything (hooks, config, backup)
npm test                 # Run tests (Vitest)
npm run test:watch       # Watch mode
npm run test:e2e         # E2E tests (Playwright)
npm run electron:dev     # Build + launch the Electron app
npm run electron:build   # Build a distributable (DMG / NSIS)
npm run debug            # Start with verbose logging
```

---

## Troubleshooting

### Hooks not firing

```bash
# Verify hooks are registered
cat ~/.claude/settings.json | grep dashboard-hook

# Test manually
echo '{"session_id":"test","hook_event_name":"SessionStart"}' | ~/.claude/hooks/dashboard-hook.sh

# Re-install
npm run install-hooks
```

### Port 3333 in use

The server auto-resolves port conflicts. To force another port:

```bash
npx ai-agent-session-center --port 4444
PORT=4444 npm start
```

### jq not installed

```bash
brew install jq            # macOS
sudo apt-get install jq    # Ubuntu/Debian
```

---

## FAQ

<details>
<summary><b>Does it modify my AI CLI?</b></summary>

No. It adds read-only, observational hook entries to your CLI's settings file (e.g. `~/.claude/settings.json`, written atomically) so it can mirror events. The CLIs themselves are untouched, and you can remove every hook with `npx ai-agent-session-center --uninstall` or `npm run reset`.
</details>

<details>
<summary><b>Does any data leave my machine?</b></summary>

No. The dashboard, hook endpoint, and message queue are all localhost-only. Nothing is sent to a remote server.
</details>

<details>
<summary><b>How do I fully uninstall?</b></summary>

Run `npx ai-agent-session-center --uninstall` to strip the hooks from all CLI configs, or `npm run reset` to also clean local config and back it up. Globally installed copies: `npm uninstall -g ai-agent-session-center`.
</details>

<details>
<summary><b>Which CLIs are supported?</b></summary>

Claude Code, Gemini CLI, and Codex CLI today. More integrations (OpenCode, Cursor, Windsurf, and other agentic frameworks) are on the roadmap.
</details>

---

## Known limitations

- **Session matching is heuristic** — linking hook events to terminals uses a multi-priority fallback; two sessions in the same working directory may occasionally cross-link.
- **Approval detection timing** — auto-approved long-running commands (npm install, builds) can briefly show as "approval" for ~8s until the PostToolUse event clears it.
- **Platform support** — developed and tested primarily on macOS. The browser dashboard works anywhere Node runs (including Linux). The Electron desktop build targets macOS and Windows; the Windows PowerShell hook variant is less battle-tested.
- **3D scene performance** — with 20+ concurrent sessions the Three.js scene may strain lower-end hardware; the 2D flat-list fallback is available.

---

## Roadmap

Contributions and ideas welcome:

- **More CLI integrations** — OpenCode, Cursor, Windsurf, or any agentic framework
- **Remote monitoring** — dashboard reachable from other machines on the network
- **Agent creation templates** — define system prompts, tools, and configs before launch
- **Collaboration** — multi-user dashboards where teams see each other's sessions
- **Plugin system** — extensible hooks for custom visualizations
- **Community themes** — user-contributed 3D scene themes and robot models

---

## Contributing

Contributions are welcome. To get started:

```bash
git clone https://github.com/coding-by-feng/ai-agent-session-center.git
cd ai-agent-session-center
npm install
npm run dev          # Vite HMR + backend
```

Run `npm test`, `npm run lint`, and `npm run typecheck` before opening a PR, and use conventional commit messages (`feat:`, `fix:`, `docs:`, …). For the full feature reference and architecture, read [`docs/feature/README.md`](docs/feature/README.md). Release notes live in [CHANGELOG.md](CHANGELOG.md).

## License

Released under the [MIT License](./LICENSE).
