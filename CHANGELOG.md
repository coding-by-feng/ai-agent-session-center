# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [2.2.0] - 2026-02-26

### Added
- Split-view tabs in session detail panel
- 3D scene toggle (enable/disable for performance)
- `--uninstall` CLI flag to remove all hooks cleanly
- Postinstall banner with getting-started instructions
- Project file browser in session detail
- Clipboard icon for terminal paste
- ALL/SSH/OTHERS segmented filter in agent sidebar
- Default CLI command suggestions in session creation
- Contributing guide and changelog

### Fixed
- Queue duplication when sending prompts
- Terminal lookup in queue send
- Detail panel closing when session is re-keyed
- Detected source overriding with 'ssh' for hook-created sessions
- Setup wizard input validation and CSP for Three.js

### Changed
- Migrated from deprecated `xterm` to `@xterm/xterm`
- Swapped navbar layout for better usability
- Hardened security for public exposure (P0)
- Mobile responsive improvements

## [2.0.4] - 2026-02-18

### Added
- 3D Cyberdrome scene with Three.js robots, pathfinding, and themed environments
- 9 scene themes (Command Center, Cyberpunk, Dracula, Nord, Monokai, Solarized, Light, Warm, Blonde)
- Session resume from history view
- WorkdirLauncher for quick session creation from working directories
- SQLite persistence with WAL mode
- Password authentication with login screen and session tokens
- Agenda system with session snapshots
- Terminal theme switcher
- Direct team linking via environment variables
- Default groups, layout presets, and instant group assignment
- Queue management enhancements
- Demo video and favicon

### Fixed
- 3D scene Error #185 (WebGL context)
- Shell detection and shell-ready detection
- Session deduplication and linkage bugs
- Setup wizard running automatically on first `npx` invocation
- Session matcher edge cases

### Changed
- Migrated to React 19 + TypeScript + Vite with full test suite (400+ tests)
- Comprehensive architecture review and security hardening (v2.0.0)
- Simplified 3D scene by removing wall sconces and room session listing
- Mobile responsive CSS improvements

## [1.0.1] - 2026-02-12

### Added
- npm publishing as `ai-agent-session-center` with CLI support (`npx` / global install)
- Multi-CLI support: Claude Code, Gemini CLI, and Codex
- Browser SSH terminal with node-pty and xterm.js
- File-based message queue transport (POSIX atomic append)
- Prompt queue with drag-and-drop reordering
- Hook stats and density controls (high/medium/low)
- Process liveness monitor (PID checking)
- IndexedDB browser storage via Dexie
- Keyboard shortcuts panel
- Quick-select label chips
- Team grouping with sub-agent visualization
- 10 character models with per-session character and color
- 3-tier session status: idle, waiting, approval
- Full CSS variable theming
- PowerShell hook variant for Windows
- Analytics with usage heatmaps and tool breakdowns

### Fixed
- Approval detection timing
- Payload size limits
- Session title generation
- Theme contrast issues

## [1.0.0] - 2026-02-10

### Added
- Initial release: real-time dashboard for monitoring Claude Code sessions
- WebSocket-based live updates
- Session state machine (idle, prompting, working, waiting, approval, input, ended)
- Hook-based event capture via bash scripts
- Express backend with REST API
- React frontend with dark theme
