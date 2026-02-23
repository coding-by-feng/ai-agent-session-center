# Session Detail Features

## Overview

When a user clicks on an agent robot in the 3D Cyberdrome scene, a detail panel slides in from the right showing comprehensive session information. This document describes the features, architecture, and data flow.

## Detail Panel Contents

### Header
- **Mini 3D robot preview**: 64×80px Canvas rendering the robot at its current animation state
- **Project name**: `session.projectName`
- **Session title**: `session.title` (italic, smaller)
- **Status badge**: Color-coded label (idle/prompting/working/waiting/approval/input/ended/connecting)
- **Model name**: `session.model` (e.g., "claude-opus-4-6")
- **Duration**: Time since `session.startedAt`

### Session Control Bar
- **Resume**: `POST /api/sessions/:id/resume` — visible when `status === 'ended'`
- **Kill**: Opens KillConfirmModal → `POST /api/sessions/:id/kill {confirm: true}`
- **Archive**: Marks ended+archived, `DELETE /api/sessions/:id`
- **Delete**: Permanent delete with browser `confirm()` dialog
- **Summarize**: Opens SummarizeModal → `POST /api/sessions/:id/summarize`
- **Alert**: Opens AlertModal — set duration alert
- **Room selector**: Dropdown to assign/move session to room or create new room
- **Label chips**: ONEOFF, HEAVY, IMPORTANT quick-assign + custom labels

### Tabs (6 total)

| Tab | Component | Content |
|-----|-----------|---------|
| **Terminal** | `TerminalContainer` | xterm.js terminal connected via WebSocket relay. Shows reconnect button for ended SSH sessions. |
| **Prompts** | `PromptHistory` | Scrollable prompt history (`session.promptHistory`). Includes previous sessions if resumed. |
| **Queue** | `QueueTab` | Prompt queue management — compose, reorder, send, move between sessions. |
| **Notes** | `NotesTab` | Per-session notes stored in localStorage by sessionId. |
| **Activity** | `ActivityLog` | Interleaved events, tool calls, and response excerpts from `session.events`, `session.toolLog`, `session.responseLog`. |
| **Summary** | `SummaryTab` | AI-generated session summary (`session.summary`). |

Tab state persisted in `localStorage['active-tab']` and restored on page refresh.

### Modals (lazy-mounted via LazyModal)
- **KillConfirmModal**: Confirms session termination with project name display
- **AlertModal**: Set alarm notification timing
- **SummarizeModal**: Choose summary template, trigger AI summarization

## Panel Sizing

| Property | Value |
|----------|-------|
| Initial width | 480px |
| Min width | 320px |
| Max width | 95vw |
| Resize mechanism | Drag handle on left edge |
| Close | Escape key (unless xterm focused), close button, click outside |

## Selection Architecture

### Data Flow (Click → Detail Panel)

```
[R3F Canvas]                              [DOM Layer]
Robot <group onClick> ──→ onSelect()      │
  └─ SessionRobot.handleClick()           │
       └─ setTimeout(() => {              │
            dispatchEvent('robot-select') ──→ CyberdromeScene useEffect handler
          })                                    ├─ selectSession(sessionId)  [sessionStore]
                                                └─ flyTo(pos + offset)      [cameraStore]
                                                      │
                                          ┌───────────┘
                                          ▼
                                  DetailPanel (DOM)
                                  └─ useSessionStore(selectedSessionId)
                                     └─ Renders session details
```

### Key Principles

1. **ZERO Zustand subscriptions inside `<Canvas>`**: All store reads happen in the DOM-side `CyberdromeScene` wrapper. Data flows into Canvas via props only.

2. **CustomEvent bridge**: Robot clicks dispatch a `CustomEvent('robot-select')` which is caught by a DOM-side `useEffect`. This ensures Zustand store updates happen exclusively in the DOM React reconciler, never in R3F's reconciler.

3. **setTimeout deferral**: The CustomEvent dispatch is wrapped in `setTimeout(0)` to ensure it fires after R3F's pointer event processing completes.

4. **Imperative store reads**: Components inside Canvas that need store data (CameraController, Robot3DModel) use `useStore.getState()` inside `useFrame` instead of subscriptions.

5. **Ref-based state**: Interactive state inside Canvas (hover, seated, dialogue, navigation) uses `useRef` instead of `useState` to prevent React re-renders in the R3F tree.

### Deselection

1. Click DetailPanel close button
2. Press Escape (unless terminal tab is focused — Escape sends `\x1b` to SSH)
3. Call `deselectSession()` → `selectedSessionId = null` → DetailPanel unmounts
4. Camera does NOT fly back (stays at current position)

## Store Dependencies

| Component | Location | Store Subscriptions |
|-----------|----------|----------------------|
| CyberdromeScene | DOM wrapper | sessionStore, roomStore, settingsStore, cameraStore |
| DetailPanel | DOM (App.tsx) | sessionStore, uiStore, wsStore |
| RobotListSidebar | DOM overlay | sessionStore, roomStore |
| SceneOverlay | DOM overlay | roomStore, sessionStore, cameraStore, settingsStore |
| MapControls | DOM overlay | cameraStore |
| SceneContent | Canvas | NONE (props only) |
| SessionRobot | Canvas | NONE (props only) |
| CameraController | Canvas | NONE (imperative reads) |
| Robot3DModel | Canvas | NONE (imperative reads) |
| SubagentConnections | Canvas | NONE (props only) |
| RoomLabels | Canvas | NONE (props only) |
| CyberdromeEnvironment | Canvas | NONE (props only) |
| RobotDialogue | Canvas | NONE (ref-based) |
| StatusParticles | Canvas | NONE (props only) |
| RobotLabel | Canvas | NONE (props only) |

## Status Colors

```
idle:       #00ff88  (green)
prompting:  #00e5ff  (cyan)
working:    #ff9100  (orange)
waiting:    #00e5ff  (cyan)
approval:   #ffdd00  (yellow)
input:      #aa66ff  (purple)
ended:      #ff4444  (red)
connecting: #666666  (gray)
```

## Robot Animation States

The 3D robot's animation is driven by a state machine mapped from session status:

| Session Status | Robot3D State | Visual Behavior |
|----------------|---------------|-----------------|
| `idle` | `idle` | Subtle bobbing, gentle arm sway, wanders around scene |
| `prompting` | `thinking` | Seated: chin-scratch with tilted head. Standing: head/arm waves |
| `working` | `working` | Tool-specific: read=scanning, write=typing, bash=arm extended, task=both arms up. Charging effect on edges. |
| `waiting` | `waiting` | Hopping celebration with arm waves |
| `approval` | `alert` | Yellow visor flash (escalates after 15s+/30s+), seated shaking or standing jitter |
| `input` | `input` | Purple visor, arm oscillation or gentle rotation |
| `ended` | `offline` | Gradual fade (visor/core dims), slumped posture if seated |
| `connecting` | `connecting` | 1.5s boot-up scale animation from zero |

### Desk Seeking

Robots seek available desks when transitioning to `working` or `thinking` states:
1. Find nearest empty desk in the robot's assigned room
2. Navigate to desk via door waypoints if crossing rooms
3. If all desks full: stand behind an occupied desk (overflow)
4. Position persisted to `sessionStorage` every 2 seconds

### Dialogue Bubbles

Triggered by state changes and tool usage. Pure ref-based (no React state). Auto-fade after 5s for non-persistent messages. Billboard at `[0, 2.8, 0]` relative to robot.

| Trigger | Message |
|---------|---------|
| `prompting` | Current prompt text |
| `approval` | "AWAITING APPROVAL" |
| `input` | "NEEDS INPUT" |
| `waiting` | "Task complete!" |
| `ended` | "OFFLINE" |
| Tool: Read | "Reading {filename}" |
| Tool: Bash | "$ {command}" |
| Tool: Edit | "Editing {file}" |
| Tool: Task | "Spawning agent" |
| Tool: WebFetch | "Fetching" |

### Status Particles

Burst effects on state transitions:
- **idle→working**: 20 yellow "up" particles (1.5s lifetime)
- **working→waiting**: 20 green confetti (gravity +2.0)
- **→approval**: 25 yellow ring (radial expand)
- **→input**: 20 purple ring
- **→ended**: 20 gray "down" particles

## Terminal Tab

### xterm.js Configuration

| Parameter | Value |
|-----------|-------|
| Font family | JetBrains Mono + Cascadia Code, Fira Code, Menlo fallbacks |
| Font size | Responsive: 11px (≤480w), 12px (≤640w), 14px (default) |
| Scrollback | 10,000 lines |
| Cursor | Bar, non-blinking |
| Addons | FitAddon, Unicode11Addon, WebLinksAddon |

### Terminal WebSocket Flow

```
Browser                    Server
  │                          │
  ├──terminal_subscribe──→   │  (register for output relay)
  │                          ├──terminal_output──→ (Base64 PTY output)
  ├──terminal_input────→     │  (user keystrokes)
  ├──terminal_resize───→     │  (50ms debounced)
  │                          │
  ├──Escape key────────→     │  (sends \x1b to SSH)
  │                          │
  └──terminal_disconnect─→   │  (close PTY)
```

### Reconnect Button

Visible when session has `terminalId`, `lastTerminalId`, or `status === 'ended'`:
- If active terminal: sends resume command via WebSocket
- If no terminal: `POST /api/sessions/:id/resume` creates new PTY

## Sound Integration

Session state changes trigger sounds via `useSound` hook:

| Event | Sound Action |
|-------|-------------|
| Session start | `sessionStart` |
| Session end | `sessionEnd` |
| Prompt submit | `promptSubmit` |
| Task complete (Stop) | `taskComplete` |
| Tool use | `toolRead`, `toolWrite`, `toolEdit`, `toolBash`, etc. |
| Approval needed | `approvalNeeded` (repeating alarm every 10s) |
| Input needed | `inputNeeded` (one-shot) |

Per-session muting and global mute respected. Per-CLI volume scaling.
