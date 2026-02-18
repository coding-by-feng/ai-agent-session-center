# Session Detail Features

## Overview

When a user clicks on an agent robot in the 3D Cyberdrome scene, a detail panel slides in from the right showing comprehensive session information. This document describes the features, architecture, and data flow.

## Detail Panel Contents

### Header
- **Mini robot icon**: Shows first letter of model type with status-colored border
- **Project name**: `session.projectName`
- **Session title**: `session.title` (italic, smaller)
- **Status badge**: Color-coded label (idle/prompting/working/waiting/approval/input/ended/connecting)
- **Model name**: `session.model` (e.g., "claude-opus-4-6")
- **Duration**: Time since `session.startedAt`

### Session Control Bar
- Kill, Archive, Resume buttons
- Labels (ONEOFF, HEAVY, IMPORTANT)
- Notes toggle
- Summarize trigger

### Tabs
| Tab | Content |
|-----|---------|
| **Terminal** | xterm.js terminal connected via WebSocket relay. Shows reconnect button for SSH sessions. |
| **Prompts** | Scrollable prompt history (`session.promptHistory`). Includes previous sessions if resumed. |
| **Activity** | Interleaved events, tool calls, and response excerpts from `session.events`, `session.toolLog`, `session.responseLog`. |
| **Notes** | Per-session markdown notes stored in IndexedDB. |
| **Summary** | AI-generated session summary (`session.summary`). |
| **Queue** | Prompt queue management — compose, reorder, send, move between sessions. |

### Modals (lazy-mounted)
- **KillConfirmModal**: Confirms session termination
- **AlertModal**: Displays alarm notifications
- **SummarizeModal**: Triggers AI summarization

## Selection Architecture

### Data Flow (Click → Detail Panel)

```
[R3F Canvas]                              [DOM Layer]
Robot <group onClick> ──→ onSelect()      │
  └─ SceneContent.handleSelect()          │
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

5. **Ref-based state**: Interactive state inside Canvas (hover, seated, dialogue) uses `useRef` instead of `useState` to prevent React re-renders in the R3F tree.

## Store Dependencies

| Component | Location | Store Subscriptions |
|-----------|----------|-------------------|
| CyberdromeScene | DOM wrapper | sessionStore, roomStore, settingsStore, cameraStore |
| DetailPanel | DOM (App.tsx) | sessionStore, uiStore, wsStore |
| RobotListSidebar | DOM overlay | sessionStore |
| SceneOverlay | DOM overlay | roomStore, sessionStore, cameraStore, settingsStore |
| MapControls | DOM overlay | cameraStore |
| SceneContent | Canvas | NONE (props only) |
| SessionRobot | Canvas | NONE (props only) |
| CameraController | Canvas | NONE (imperative reads) |
| Robot3DModel | Canvas | NONE (imperative reads) |
| SubagentConnections | Canvas | NONE (props only) |
| RoomLabels | Canvas | NONE (props only) |
| CyberdromeEnvironment | Canvas | NONE (props only) |

## Status Colors

```
idle:       #00ff88  (green)
prompting:  #00e5ff  (cyan)
working:    #ff9100  (orange)
waiting:    #00e5ff  (cyan)
approval:   #ffdd00  (yellow)
input:      #aa66ff  (purple)
ended:      #ff4444  (red)
connecting: #666     (gray)
```
