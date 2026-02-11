# AI Agent Session Center

## Project Overview

A localhost dashboard (port 3333) that monitors all active Claude Code sessions via hooks. Each session is represented by a 3D animated RobotExpressive character. Users can click on any robot to select it and view full prompt history, response history, tool logs, and session details.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js (ESM) + Express 5 + ws 8 |
| Frontend | Vanilla JS + Three.js 0.170 (import maps, zero build) |
| 3D Model | RobotExpressive.glb (CC0, from Three.js CDN) |
| Hooks | Bash script (curl POST to localhost:3333) |
| Port | 3333 |

## Commands

```bash
# Install dependencies
npm install

# Start the dashboard server
npm start

# Install hooks into ~/.claude/settings.json
npm run install-hooks
```

## Architecture

```
Claude Code Sessions ──(hooks POST)──> Express Server ──(WebSocket)──> Browser
                                           │
                                      In-memory Map
                                     (session states)
```

## Project Structure

```
server/
├── index.js              # Express + WebSocket server entry
├── sessionStore.js       # In-memory session state machine (core logic)
├── hookRouter.js         # POST /api/hooks endpoint
└── wsManager.js          # WebSocket broadcast to connected browsers

public/
├── index.html            # Dashboard with Three.js import maps
├── css/
│   └── dashboard.css     # Dark command-center theme (neon accents)
└── js/
    ├── app.js            # Bootstrap: init scene, connect WS, render loop
    ├── sceneManager.js   # Three.js renderer with viewport-per-session
    ├── robotManager.js   # Load/clone/animate RobotExpressive models
    ├── sessionPanel.js   # HTML session cards + click-to-expand detail panel
    ├── wsClient.js       # WebSocket client with auto-reconnect
    └── statsPanel.js     # Global stats header bar

hooks/
├── dashboard-hook.sh     # Bash: reads stdin JSON, POSTs to localhost:3333
└── install-hooks.js      # Merges hook config into ~/.claude/settings.json
```

## Key Design Decisions

- **Single renderer with viewports**: One WebGL context, `setViewport/setScissor` per session card. More performant than multiple canvases.
- **Model clone strategy**: Load RobotExpressive.glb once, `SkeletonUtils.clone()` per session. Each clone gets a unique emissive color tint.
- **Async hooks**: All Claude Code hooks use `async: true` so they never block Claude. `curl -m 2` with fire-and-forget.
- **No build step**: Import maps for Three.js from CDN. Vanilla JS modules. No webpack/vite needed.
- **In-memory store**: No database. Sessions are ephemeral. State rebuilds from hooks on restart.

## Session State Machine

```
SessionStart -> idle (Idle animation)
UserPromptSubmit -> prompting (Wave + Walking)
PreToolUse -> working (Running)
PostToolUse -> working (stays)
Stop -> idle (ThumbsUp/Dance + Idle)
SessionEnd -> ended (Death, removed after 60s)
```

## Important Files

- `~/.claude/settings.json` - Where hooks are registered (install-hooks.js modifies this)
- `~/.claude/hooks/dashboard-hook.sh` - The hook script deployed to ~/.claude/hooks/
- `~/.claude/hooks/save_conversation.py` - EXISTING hook, must not be overwritten

## Interaction: Click-to-Select Robot

When user clicks a robot/session card:
1. Robot plays a "Yes" emote (acknowledgment)
2. Detail panel slides in from the right
3. Panel shows: project name, full prompt history (scrollable), response excerpts, tool call log with timestamps, session duration, model info
4. Other robots dim slightly (0.3 opacity) to highlight the selected one
5. Click elsewhere or close button to deselect

## Styles

- Dark navy background (#0a0a1a)
- Neon accent colors: cyan (prompting), orange (working), green (idle), red (ended)
- JetBrains Mono font
- Glowing card borders that pulse based on status
- Scanline overlay for retro game feel
